#!/usr/bin/env bash
set -e

# Builds an installable Android APK locally on macOS
# Default backend URL points to Render (can be customized via argument or in-app sign-in setting)
API_URL="${1:-https://ambulance-booking-api.onrender.com}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$(cd "$APP_DIR/../.." && pwd)/dist"
ANDROID_DIR="$APP_DIR/android"

echo "=========================================="
echo "🚑 Building Ambulance Booking System APK"
echo "API Target: $API_URL"
echo "=========================================="

# 1. Setup Java Environment
if [ -d "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home" ]; then
  export JAVA_HOME="/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"
elif [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
else
  export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null)"
fi

if [ -z "$JAVA_HOME" ] || [ ! -d "$JAVA_HOME" ]; then
  echo "❌ Error: Could not locate Java 17 Runtime."
  exit 1
fi
echo "✓ Using JAVA_HOME: $JAVA_HOME"

# 2. Setup Android SDK
if [ -z "$ANDROID_HOME" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ ! -d "$ANDROID_HOME" ]; then
  echo "❌ Error: Android SDK not found at $ANDROID_HOME."
  exit 1
fi
echo "✓ Using ANDROID_HOME: $ANDROID_HOME"

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# 3. Bake environment variables for bundling
export EXPO_PUBLIC_API_URL="$API_URL"
export EXPO_PUBLIC_MAPTILER_KEY="6mLLgOMyLQp0DFy6CtAC"
export EXPO_PUBLIC_NOMINATIM_URL="https://nominatim.openstreetmap.org"
export EXPO_PUBLIC_OSRM_URL="https://router.project-osrm.org"

# 4. Generate/Regenerate native Android project via Expo prebuild
echo ""
echo "⚙️  Generating Android native project (expo prebuild)..."
cd "$APP_DIR"
npx expo prebuild --platform android --no-install

# 5. Write local.properties for Gradle
echo "sdk.dir=$ANDROID_HOME" > "$ANDROID_DIR/local.properties"

# 6. Build APK with Gradle
echo ""
echo "🔨 Compiling Android APK with Gradle..."
cd "$ANDROID_DIR"
chmod +x ./gradlew

# Build release APK (uses standard debug signing by default in React Native for local testing)
./gradlew assembleRelease

# 7. Locate and copy APK to dist
RELEASE_APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$RELEASE_APK" ]; then
  # Check alternative output paths
  RELEASE_APK=$(find "$ANDROID_DIR/app/build/outputs/apk" -name "*.apk" | head -n 1)
fi

if [ -z "$RELEASE_APK" ] || [ ! -f "$RELEASE_APK" ]; then
  echo "❌ Error: Gradle finished but no APK was found in build outputs."
  exit 1
fi

mkdir -p "$DIST_DIR"
DEST_APK="$DIST_DIR/AmbulanceBooking.apk"
cp "$RELEASE_APK" "$DEST_APK"

FILE_SIZE=$(du -h "$DEST_APK" | cut -f1)

echo ""
echo "=========================================="
echo "✅ APK BUILT SUCCESSFULLY!"
echo "Location: $DEST_APK"
echo "Size:     $FILE_SIZE"
echo "Backend:  $API_URL"
echo "=========================================="
echo "You can transfer this APK directly to your Android device via USB, AirDrop, or Google Drive."
