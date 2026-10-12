# Cloud Deployment Guide (Render)

This guide walks you through deploying the Ambulance Booking System backend to **Render** (free cloud hosting) and building the production APK so that **anyone who downloads the app can immediately use it over the internet**.

---

## Step 1: Push Project to GitHub

Render builds your backend directly from your GitHub repository.

1. Initialize git and commit your files (if not already done):
   ```bash
   git init
   git add .
   git commit -m "Deploy Ambulance Booking System with in-app voice calling & email OTP"
   ```

2. Create a new repository on GitHub (e.g., `Ambulance_Booking_System`) and push:
   ```bash
   git remote add origin https://github.com/<your-username>/Ambulance_Booking_System.git
   git branch -M main
   git push -u origin main
   ```

---

## Step 2: Deploy Backend on Render

1. Go to [https://render.com](https://render.com) and sign in (with GitHub).
2. Click **New +** ➔ **Web Service**.
3. Choose **Build and deploy from a Git repository** and connect your GitHub repo.
4. Fill in the following settings:
   - **Name**: `ambulance-booking-backend` *(or any unique name you prefer)*
   - **Region**: Singapore or Frankfurt *(closest to your users)*
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Click **Advanced** ➔ **Add Environment Variable** and add these:
   | Key | Value | Description |
   |---|---|---|
   | `NODE_VERSION` | `22.11.0` | Required for native SQLite |
   | `NODE_ENV` | `production` | Production mode |
   | `CORS_ORIGIN` | `*` | Allows mobile apps & web to connect |
   | `JWT_SECRET` | *(click Generate)* | Random secure key |
   | `OTP_CHANNEL` | `email` | Email OTP verification |
   | `EMAIL_PROVIDER` | `smtp` | SMTP service |
   | `SMTP_HOST` | `smtp.gmail.com` | Gmail SMTP |
   | `SMTP_PORT` | `465` | SSL Port |
   | `SMTP_SECURE` | `true` | Secure connection |
   | `SMTP_USER` | `devjipatelop@gmail.com` | Your Gmail address |
   | `SMTP_PASS` | `ravgiolawvhaiajj` | Your Gmail App Password |
   | `EMAIL_FROM` | `Ambulance Booking System <devjipatelop@gmail.com>` | Sender display name |
   | `EXPOSE_OTP_IN_RESPONSE` | `true` | Exposes OTP in test dev response |

6. Click **Deploy Web Service**.
7. Wait 2–3 minutes until Render shows **"Your service is live 🎉"**.
8. Copy your live Render URL, which will look like:
   ```text
   https://ambulance-booking-backend.onrender.com
   ```
9. Verify by opening in browser:
   `https://ambulance-booking-backend.onrender.com/health`

---

## Step 3: Bake the Render URL into the Mobile APK

Now set the Render URL as the permanent default in the mobile app:

1. Open `mobile/app/.env` and update:
   ```env
   EXPO_PUBLIC_API_URL=https://your-service-name.onrender.com
   ```

2. Rebuild the Android Release APK:
   ```bash
   export ANDROID_HOME=$HOME/Library/Android/sdk
   cd mobile/app/android
   ./gradlew assembleRelease
   ```

3. Copy the APK to the root folder:
   ```bash
   cp mobile/app/android/app/build/outputs/apk/release/app-release.apk /Users/devpatel/Desktop/Ambulance_Booking_System-main/ambulance-app.apk
   ```

---

## Step 4: Share with Anyone!

Now, **`ambulance-app.apk`** is completely self-contained:
- Anyone who installs it on Android can open the app anywhere in the world on mobile data (4G/5G) or Wi-Fi.
- They will immediately connect to your live Render backend without typing any IP addresses.
- Registration with Gmail OTP, booking ambulances, live GPS tracking, and in-app WebRTC voice calls will work everywhere over the internet.
