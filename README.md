# ERROR Video Downloader

Node 24 + Express 5 + latest yt-dlp + ffmpeg. Video+audio merge, MP3/M4A/OPUS audio, live progress, in-page playback.

## Run
```
docker build -t error-dl .
docker run -p 3000:3000 -v $PWD/data:/data error-dl
```

## Your own art
Put images in `public/img/`: `avatar.png` (round logo), `banner.png` (banner background), `side.png` (sidebar art).

## YouTube blocking (important for online servers)
YouTube blocks most datacenter IPs. If YouTube fails on your host (it works on your PC), set one or more of:
- `/data/cookies.txt` – Netscape cookies exported from a logged-in YouTube session (use a throwaway account)
- `PROXY_URL` – residential/ISP proxy, e.g. `http://user:pass@host:port`
- `POT_PROVIDER_URL` – a bgutil PO-token provider server URL

yt-dlp self-updates on start and every 6h. Other env: `PORT`, `MAX_JOBS` (default 3), `COOKIES_FILE`.
