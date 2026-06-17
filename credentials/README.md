# Credentials

This folder holds the Google Cloud service account key used by the
**ai-service** for Thai Speech-to-Text (Google STT).

## Required file

Place your Google Cloud service account JSON here:

```
credentials/google-service-account.json
```

This exact filename is required. `docker-compose.yml` mounts this folder
read-only into the ai-service container at `/app/credentials`, and sets:

```
GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/google-service-account.json
```

## How to obtain it

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Cloud Speech-to-Text API** for your project.
3. Go to **IAM & Admin -> Service Accounts**.
4. Create a service account (or pick an existing one) with permission to use
   Speech-to-Text.
5. Under **Keys**, choose **Add Key -> Create new key -> JSON** and download it.
6. Save the downloaded file as `credentials/google-service-account.json`.

## Security

- This JSON is a **secret**. It is git-ignored via the root `.gitignore`
  (`credentials/*.json`), so it will not be committed.
- Only the empty `.gitkeep` marker file in this folder is tracked, so the
  directory exists for the volume mount even on a fresh clone.
- Never commit or share this key. Rotate it immediately if it leaks.
