import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { colors, radius, spacing, typo } from '../lib/theme';
import { getSocket } from '../lib/socket';

/**
 * In-App WebRTC Voice Call Engine & UI Modal.
 * Enables zero-cost, private voice calling directly between Patient and Driver.
 */

const CALL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="background:transparent;margin:0;overflow:hidden;">
  <audio id="remoteAudio" autoplay playsinline></audio>
  <script>
    let pc = null;
    let localStream = null;
    const remoteAudio = document.getElementById('remoteAudio');

    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    function post(type, payload = {}) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...payload }));
      }
    }

    async function initStream() {
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
      }
      return localStream;
    }

    function createPC() {
      if (pc) {
        try { pc.close(); } catch(e){}
      }
      pc = new RTCPeerConnection(config);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          post('signal', { signal: { candidate: event.candidate } });
        }
      };

      pc.onconnectionstatechange = () => {
        post('connectionState', { state: pc.connectionState });
        if (pc.connectionState === 'connected') {
          post('connected');
        }
      };

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteAudio.srcObject = event.streams[0];
          remoteAudio.play().catch(e => console.log('Audio play error', e));
        }
      };

      return pc;
    }

    window.handleCall = async function(action, payload) {
      try {
        if (action === 'START_OFFER') {
          await initStream();
          const peer = createPC();
          localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
          const offer = await peer.createOffer({ offerToReceiveAudio: 1 });
          await peer.setLocalDescription(offer);
          post('signal', { signal: { sdp: peer.localDescription } });
        } else if (action === 'ACCEPT_OFFER') {
          await initStream();
          const peer = createPC();
          localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
        } else if (action === 'PROCESS_SIGNAL') {
          const sig = payload.signal;
          if (!pc) {
            await initStream();
            createPC();
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
          }

          if (sig.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
            if (sig.sdp.type === 'offer') {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              post('signal', { signal: { sdp: pc.localDescription } });
            }
          } else if (sig.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
          }
        } else if (action === 'SET_MUTE') {
          if (localStream) {
            localStream.getAudioTracks().forEach(t => { t.enabled = !payload.muted; });
          }
        } else if (action === 'END') {
          if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
          }
          if (pc) {
            pc.close();
            pc = null;
          }
          if (remoteAudio) {
            remoteAudio.srcObject = null;
          }
        }
      } catch (err) {
        post('error', { error: err.message || String(err) });
      }
    };

    window.onload = function() {
      post('engine_ready');
    };
  </script>
</body>
</html>
`;

export default function VoiceCallModal({
  visible,
  onClose,
  bookingId,
  partnerName,
  partnerRole,
  isCaller = false,
  incomingCallData = null,
}) {
  const [callState, setCallState] = useState(isCaller ? 'DIALING' : 'INCOMING'); // DIALING, RINGING, CONNECTED, ENDED
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [statusText, setStatusText] = useState(isCaller ? 'Calling…' : 'Incoming call…');
  const [engineReady, setEngineReady] = useState(false);

  const webRef = useRef(null);
  const timerRef = useRef(null);

  // Request native Android microphone permission
  async function ensureMicPermission() {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'In-app voice calling requires access to your microphone.',
            buttonPositive: 'Allow',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch {
        return false;
      }
    }
    return true;
  }

  const sendEngine = (action, payload = {}) => {
    if (!webRef.current) return;
    const js = `window.handleCall && window.handleCall(${JSON.stringify(action)}, ${JSON.stringify(payload)}); true;`;
    webRef.current.injectJavaScript(js);
  };

  // Start timer on call connected
  useEffect(() => {
    if (callState === 'CONNECTED') {
      setDuration(0);
      timerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  // Vibrate on incoming call
  useEffect(() => {
    if (visible && callState === 'INCOMING') {
      Vibration.vibrate([500, 1000, 500, 1000], true);
    } else {
      Vibration.cancel();
    }
    return () => Vibration.cancel();
  }, [visible, callState]);

  // Socket.IO event listeners
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !visible) return undefined;

    const onCallAccepted = () => {
      setStatusText('Connecting…');
    };

    const onCallRejected = ({ reason }) => {
      setStatusText(reason === 'busy' ? 'Line busy' : 'Call declined');
      setCallState('ENDED');
      setTimeout(handleClose, 1800);
    };

    const onCallEnded = () => {
      setStatusText('Call ended');
      setCallState('ENDED');
      sendEngine('END');
      setTimeout(handleClose, 1500);
    };

    const onCallSignal = ({ signal }) => {
      sendEngine('PROCESS_SIGNAL', { signal });
    };

    socket.on('call:accepted', onCallAccepted);
    socket.on('call:rejected', onCallRejected);
    socket.on('call:ended', onCallEnded);
    socket.on('call:signal', onCallSignal);

    return () => {
      socket.off('call:accepted', onCallAccepted);
      socket.off('call:rejected', onCallRejected);
      socket.off('call:ended', onCallEnded);
      socket.off('call:signal', onCallSignal);
    };
  }, [visible]);

  // Handle caller start
  useEffect(() => {
    if (visible && isCaller && engineReady && bookingId) {
      (async () => {
        const ok = await ensureMicPermission();
        if (!ok) {
          setStatusText('Microphone permission denied');
          setCallState('ENDED');
          setTimeout(handleClose, 2000);
          return;
        }

        const socket = getSocket();
        if (socket) {
          socket.emit('call:invite', {
            bookingId,
            callerName: partnerName || 'Ambulance Contact',
            callerRole: partnerRole,
          });
        }
        setStatusText('Ringing…');
        sendEngine('START_OFFER');
      })();
    }
  }, [visible, isCaller, engineReady, bookingId]);

  // Accept incoming call
  async function acceptCall() {
    Vibration.cancel();
    const ok = await ensureMicPermission();
    if (!ok) {
      setStatusText('Microphone permission denied');
      return;
    }

    const socket = getSocket();
    if (socket && bookingId) {
      socket.emit('call:accept', { bookingId });
    }
    setStatusText('Connecting…');
    setCallState('CONNECTING');
    sendEngine('ACCEPT_OFFER');
  }

  // Reject / Decline call
  function declineCall() {
    Vibration.cancel();
    const socket = getSocket();
    if (socket && bookingId) {
      socket.emit('call:reject', { bookingId, reason: 'declined' });
    }
    sendEngine('END');
    handleClose();
  }

  // Hang up active or dialing call
  function endCall() {
    Vibration.cancel();
    const socket = getSocket();
    if (socket && bookingId) {
      socket.emit('call:end', { bookingId });
    }
    sendEngine('END');
    setStatusText('Call ended');
    setCallState('ENDED');
    setTimeout(handleClose, 800);
  }

  function toggleMute() {
    const nextMuted = !muted;
    setMuted(nextMuted);
    sendEngine('SET_MUTE', { muted: nextMuted });
  }

  function handleClose() {
    Vibration.cancel();
    sendEngine('END');
    setCallState(isCaller ? 'DIALING' : 'INCOMING');
    setMuted(false);
    setDuration(0);
    onClose && onClose();
  }

  const handleWebMessage = (e) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'engine_ready') {
        setEngineReady(true);
      } else if (msg.type === 'signal') {
        const socket = getSocket();
        if (socket && bookingId) {
          socket.emit('call:signal', { bookingId, signal: msg.signal });
        }
      } else if (msg.type === 'connected') {
        setCallState('CONNECTED');
        setStatusText('In-App Voice Call');
      } else if (msg.type === 'error') {
        console.log('WebRTC Call Engine Error:', msg.error);
      }
    } catch (err) {
      // ignore
    }
  };

  const formatTimer = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={endCall}>
      <View style={styles.overlay}>
        {/* Hidden WebRTC Audio WebView */}
        <View style={styles.hiddenWeb}>
          <WebView
            ref={webRef}
            source={{ html: CALL_HTML }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback
            onMessage={handleWebMessage}
          />
        </View>

        {/* Call Container Card */}
        <View style={styles.card}>
          <View style={styles.avatarWrap}>
            <View style={[styles.avatarPulse, callState === 'CONNECTED' && styles.avatarPulseActive]}>
              <Text style={styles.avatarIcon}>
                {partnerRole === 'DRIVER' ? '🚑' : '🧑‍⚕️'}
              </Text>
            </View>
          </View>

          <Text style={styles.partnerName}>{partnerName || 'Ambulance Contact'}</Text>
          <Text style={styles.partnerRole}>
            {partnerRole === 'DRIVER' ? 'Ambulance Driver' : 'Patient / Booker'}
          </Text>

          <View style={styles.statusBadge}>
            <View
              style={[
                styles.statusDot,
                callState === 'CONNECTED' ? styles.dotGreen : styles.dotAmber,
              ]}
            />
            <Text style={styles.statusText}>
              {callState === 'CONNECTED' ? formatTimer(duration) : statusText}
            </Text>
          </View>

          {/* Action Buttons */}
          {callState === 'INCOMING' ? (
            <View style={styles.incomingControls}>
              <Pressable style={[styles.actionBtn, styles.declineBtn]} onPress={declineCall}>
                <Text style={styles.btnIcon}>✕</Text>
                <Text style={styles.btnLabel}>Decline</Text>
              </Pressable>

              <Pressable style={[styles.actionBtn, styles.acceptBtn]} onPress={acceptCall}>
                <Text style={styles.btnIcon}>📞</Text>
                <Text style={styles.btnLabel}>Accept</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.activeControls}>
              <Pressable
                style={[styles.smallActionBtn, muted && styles.smallActionBtnActive]}
                onPress={toggleMute}
              >
                <Text style={styles.smallBtnIcon}>{muted ? '🔇' : '🎙️'}</Text>
                <Text style={styles.smallBtnLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
              </Pressable>

              <Pressable style={[styles.actionBtn, styles.endCallBtn]} onPress={endCall}>
                <Text style={styles.btnIcon}>📞</Text>
                <Text style={styles.btnLabel}>End Call</Text>
              </Pressable>
            </View>
          )}

          <Text style={styles.encryptedNotice}>
            🔒 End-to-end encrypted in-app voice call
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(10, 15, 29, 0.94)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  hiddenWeb: {
    width: 1,
    height: 1,
    opacity: 0,
    position: 'absolute',
    top: -100,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#161F30',
    borderRadius: 24,
    padding: spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 20,
  },
  avatarWrap: {
    marginVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPulse: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 2,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPulseActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.5)',
  },
  avatarIcon: {
    fontSize: 50,
  },
  partnerName: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.white,
    textAlign: 'center',
  },
  partnerRole: {
    fontSize: 13.5,
    color: colors.muted,
    marginTop: 4,
    textAlign: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.md,
    marginBottom: spacing.xl,
    paddingVertical: 6,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 20,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotAmber: {
    backgroundColor: '#F59E0B',
  },
  statusText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  incomingControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xl,
    width: '100%',
    marginVertical: spacing.md,
  },
  activeControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xl,
    width: '100%',
    marginVertical: spacing.md,
  },
  actionBtn: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  acceptBtn: {
    backgroundColor: '#10B981',
  },
  declineBtn: {
    backgroundColor: '#EF4444',
  },
  endCallBtn: {
    backgroundColor: '#EF4444',
    transform: [{ rotate: '135deg' }],
  },
  btnIcon: {
    fontSize: 28,
    color: colors.white,
  },
  btnLabel: {
    fontSize: 11,
    color: colors.white,
    marginTop: 2,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  smallActionBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallActionBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.3)',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  smallBtnIcon: {
    fontSize: 22,
  },
  smallBtnLabel: {
    fontSize: 10,
    color: colors.white,
    marginTop: 2,
    fontWeight: '600',
  },
  encryptedNotice: {
    marginTop: spacing.xl,
    fontSize: 11,
    color: colors.muted,
    textAlign: 'center',
  },
});
