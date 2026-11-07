
import { DurableObject } from "cloudflare:workers";

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Screen Projector</title>
<style>
  body{font:16px system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;color:#161616}
  button{font:inherit;padding:10px 16px;margin:8px 8px 8px 0;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  video{display:block;width:100%;max-height:78vh;background:#111;margin-top:16px}
  #status{padding:10px 0;color:#555}
</style>
</head>
<body>
<h2>Screen Projector</h2>
<div id="status">Connecting...</div>

<label for="audioMode">Audio to send (presenter only):</label>
<select id="audioMode">
  <option value="none">No audio</option>
  <option value="device">Shared screen / tab / system audio</option>
  <option value="microphone">System microphone</option>
</select>

<button id="share" disabled>Share this screen</button>
<button id="stop" disabled>Stop sharing</button>
<button id="enableAudio">Enable projector audio</button>

<div id="count">Connected devices: 1 / 2</div>
<video id="screen" autoplay playsinline controls></video>

<p>For screen audio, choose a browser tab or screen source that offers audio sharing in the browser picker. Microphone mode uses your system's default input device.</p>

<script>
(() => {
  const statusEl = document.getElementById("status");
  const countEl = document.getElementById("count");
  const shareBtn = document.getElementById("share");
  const stopBtn = document.getElementById("stop");
  const audioModeEl = document.getElementById("audioMode");
  const enableAudioBtn = document.getElementById("enableAudio");
  const video = document.getElementById("screen");

  let ws = null, myId = null, peerId = null, pc = null;
  let localStream = null, pendingCandidates = [];
  let busy = false, sharing = false, remoteSharing = false;
  let captureHasAudio = false;

  const setStatus = (s) => { statusEl.textContent = s; };

  const send = (message) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const update = () => {
    countEl.textContent = "Connected devices: " + (peerId ? "2" : "1") + " / 2";
    shareBtn.disabled = !peerId || !ws ||
      ws.readyState !== WebSocket.OPEN ||
      busy || sharing || remoteSharing;
    stopBtn.disabled = !sharing;
    audioModeEl.disabled = busy || sharing;
  };

  function closePeer(clearCandidates = true) {
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    if (clearCandidates) pendingCandidates = [];
    video.srcObject = null;
  }

  function stopLocal(sendRelease) {
    if (sendRelease) send({ type: "release" });

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      localStream = null;
    }

    sharing = false;
    busy = false;
    captureHasAudio = false;
    closePeer();
    update();
  }

  function makePeerConnection() {
    const connection = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.cloudflare.com:3478" }
      ]
    });

    connection.onicecandidate = (event) => {
      if (event.candidate && peerId) {
        send({
          type: "candidate",
          to: peerId,
          payload: event.candidate.toJSON()
        });
      }
    };

    connection.ontrack = (event) => {
      video.srcObject =
        event.streams[0] || new MediaStream([event.track]);

      video.muted = false;

      video.play().catch(() => {
        setStatus("Screen received. Click Enable projector audio if you cannot hear it.");
      });

      setStatus(
        event.track.kind === "audio"
          ? "Receiving screen and audio."
          : "Receiving screen."
      );
    };

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected") {
        setStatus(
          sharing
            ? (captureHasAudio
                ? "Sharing screen and audio."
                : "Sharing screen (no audio).")
            : "Screen connected."
        );
      }

      if (connection.connectionState === "failed") {
        setStatus("Connection failed. Try again or use a different network.");
      }
    };

    return connection;
  }

  async function flushCandidates() {
    if (!pc || !pc.remoteDescription) return;

    const queued = pendingCandidates.splice(0);

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("ICE candidate:", e);
      }
    }
  }

  async function handleSignal(message) {
    if (message.type === "offer") {
      closePeer(false);
      pc = makePeerConnection();

      await pc.setRemoteDescription(message.payload);
      await flushCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      send({
        type: "answer",
        to: message.from,
        payload: pc.localDescription
      });

      setStatus("Connecting to the shared screen...");

    } else if (message.type === "answer") {
      if (!pc) return;

      await pc.setRemoteDescription(message.payload);
      await flushCandidates();

      setStatus("Connecting to the projector...");

    } else if (message.type === "candidate") {
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(message.payload);
        } catch (e) {
          console.warn("ICE candidate:", e);
        }
      } else {
        pendingCandidates.push(message.payload);
      }
    }
  }

  async function handleMessage(message) {
    if (message.type === "welcome") {
      myId = message.id;
      peerId = (message.peers || [])[0] || null;
      remoteSharing = !!message.presenterActive;

      setStatus(
        !peerId
          ? "Waiting for the second device to open this page..."
          : remoteSharing
              ? "The other device is sharing."
              : "Both devices are connected. Start sharing on one device."
      );

      update();
      return;
    }

    if (message.type === "peer-joined") {
      peerId = message.id;
      remoteSharing = false;

      setStatus("Both devices are connected. Start sharing on one device.");
      update();
      return;
    }

    if (message.type === "peer-left") {
      if (message.id === peerId) {
        peerId = null;
        stopLocal(true);
        remoteSharing = false;

        setStatus("The other device disconnected. Waiting for another device...");
      }

      update();
      return;
    }

    if (message.type === "claim-ok") {
      remoteSharing = false;
      busy = false;
      sharing = true;
      update();

      try {
        closePeer();
        pc = makePeerConnection();

        // Both video and audio tracks are transmitted.
        localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        send({
          type: "offer",
          to: peerId,
          payload: pc.localDescription
        });

        setStatus(
          captureHasAudio
            ? "Sharing screen and audio. The other device is connecting..."
            : "Sharing screen. The other device is connecting..."
        );

      } catch (e) {
        console.error(e);
        setStatus("Could not start the connection: " + e.message);
        stopLocal(true);
      }

      return;
    }

    if (message.type === "claim-denied") {
      remoteSharing = true;
      stopLocal(false);
      setStatus(message.reason || "The other device is already sharing.");
      return;
    }

    if (message.type === "presenter-started") {
      remoteSharing = true;
      update();
      setStatus("The other device is starting screen sharing...");
      return;
    }

    if (message.type === "presenter-stopped") {
      remoteSharing = false;
      closePeer();
      update();

      if (!sharing) {
        setStatus("Screen sharing stopped. You can start a new session.");
      }

      return;
    }

    if (message.type === "peer-missing") {
      setStatus("The other device is no longer connected. Refresh both devices to reconnect.");
      return;
    }

    if (
      ["offer", "answer", "candidate"].includes(message.type) &&
      message.from === peerId
    ) {
      try {
        await handleSignal(message);
      } catch (e) {
        console.error(e);
        setStatus("WebRTC error: " + e.message);
      }
    }
  }

  shareBtn.addEventListener("click", async () => {
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getDisplayMedia
    ) {
      setStatus("Screen sharing is not supported by this browser. Try desktop Chrome or Edge.");
      return;
    }

    busy = true;
    update();

    try {
      const audioMode = audioModeEl.value;

      // Capture screen and optionally its audio.
      // This call must originate from the button click.
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 }
        },
        audio: audioMode === "device",
        ...(audioMode === "device"
          ? {
              systemAudio: "include",
              windowAudio: "system"
            }
          : {})
      });

      // Alternatively capture the system's default microphone.
      if (audioMode === "microphone") {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

        micStream.getAudioTracks().forEach((track) => {
          localStream.addTrack(track);
        });
      }

      captureHasAudio = localStream.getAudioTracks().length > 0;

      if (audioMode !== "none" && !captureHasAudio) {
        setStatus("The browser did not provide an audio track. Screen sharing can continue without audio; try a different source or microphone mode.");
      }

      if (!peerId || !ws || ws.readyState !== WebSocket.OPEN) {
        stopLocal(false);
        setStatus("The other device disconnected. Reopen this page on both devices.");
        return;
      }

      const track = localStream.getVideoTracks()[0];

      if (track) {
        track.onended = () => stopLocal(true);
      }

      localStream.getAudioTracks().forEach((audioTrack) => {
        audioTrack.onended = () => {
          captureHasAudio = localStream
            ? localStream.getAudioTracks().some((t) => t.readyState === "live")
            : false;

          setStatus("Audio capture ended. Screen sharing may continue.");
        };
      });

      send({ type: "claim" });

      if (audioMode !== "none" && !captureHasAudio) {
        setStatus("Waiting to share screen (no audio track was provided by the browser)...");
      } else {
        setStatus("Waiting to start sharing...");
      }

    } catch (e) {
      stopLocal(false);

      setStatus(
        e.name === "NotAllowedError"
          ? "Screen or microphone permission was denied/cancelled."
          : "Capture error: " + e.message
      );
    }
  });

  stopBtn.addEventListener("click", () => {
    stopLocal(true);
    setStatus("Screen sharing stopped.");
  });

  enableAudioBtn.addEventListener("click", async () => {
    video.muted = false;

    try {
      await video.play();
      setStatus("Projector audio enabled.");
    } catch (e) {
      setStatus("Playback is blocked by the browser. Click the video player's play button.");
    }
  });

  function connect() {
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";

    ws = new WebSocket(scheme + location.host + "/ws");

    ws.onopen = () => {
      setStatus("Connected. Waiting for the other device...");
    };

    ws.onmessage = async (event) => {
      try {
        await handleMessage(JSON.parse(event.data));
      } catch (e) {
        console.error(e);
        setStatus("Signaling error: " + e.message);
      }
    };

    ws.onclose = () => {
      stopLocal(false);
      peerId = null;
      update();
      setStatus("Disconnected from the server. Refresh this page to reconnect.");
    };

    ws.onerror = () => {
      setStatus("WebSocket connection error.");
    };
  }

  if (!window.isSecureContext) {
    setStatus("This page needs HTTPS for browser screen sharing.");
  }

  connect();
  update();
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const origin = request.headers.get("Origin");

      if (origin && origin !== url.origin) {
        return new Response("Origin not allowed", { status: 403 });
      }

      const id = env.ROOM.idFromName("one-public-projector-room");
      return env.ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};

// One globally shared room: exactly two connected browsers at a time.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const active = this.ctx.getWebSockets().filter(
      (ws) => ws.readyState === WebSocket.OPEN
    );

    if (active.length >= 2) {
      return new Response(
        "This projector room is full (2 devices maximum).",
        { status: 409 }
      );
    }

    const peers = active
      .map((ws) => ws.deserializeAttachment()?.id)
      .filter(Boolean);

    const presenterActive = active.some(
      (ws) => ws.deserializeAttachment()?.role === "presenter"
    );

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const session = {
      id: crypto.randomUUID(),
      role: "viewer"
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);

    server.send(JSON.stringify({
      type: "welcome",
      id: session.id,
      peers,
      presenterActive
    }));

    for (const peer of active) {
      try {
        peer.send(JSON.stringify({
          type: "peer-joined",
          id: session.id
        }));
      } catch (_) {}
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 200000) {
      try { ws.close(1009, "Message too large or invalid"); } catch (_) {}
      return;
    }

    let message;

    try {
      message = JSON.parse(raw);
    } catch (_) {
      return;
    }

    const session = ws.deserializeAttachment() || {};

    const sockets = this.ctx.getWebSockets().filter(
      (peer) => peer.readyState === WebSocket.OPEN
    );

    const peers = sockets.filter((peer) => peer !== ws);

    if (message.type === "claim") {
      if (!peers.length) {
        ws.send(JSON.stringify({
          type: "claim-denied",
          reason: "Wait for the second device to connect first."
        }));
        return;
      }

      const alreadySharing = sockets.some(
        (peer) =>
          peer !== ws &&
          peer.deserializeAttachment()?.role === "presenter"
      );

      if (alreadySharing) {
        ws.send(JSON.stringify({
          type: "claim-denied",
          reason: "The other device is already sharing."
        }));
        return;
      }

      session.role = "presenter";
      ws.serializeAttachment(session);
      ws.send(JSON.stringify({ type: "claim-ok" }));

      for (const peer of peers) {
        try {
          peer.send(JSON.stringify({ type: "presenter-started" }));
        } catch (_) {}
      }

      return;
    }

    if (message.type === "release") {
      if (session.role === "presenter") {
        session.role = "viewer";
        ws.serializeAttachment(session);

        for (const peer of peers) {
          try {
            peer.send(JSON.stringify({ type: "presenter-stopped" }));
          } catch (_) {}
        }
      }

      return;
    }

    if (!["offer", "answer", "candidate"].includes(message.type)) {
      return;
    }

    if (
      typeof message.to !== "string" ||
      !message.payload ||
      typeof message.payload !== "object"
    ) {
      return;
    }

    const target = peers.find(
      (peer) => peer.deserializeAttachment()?.id === message.to
    );

    if (!target) {
      ws.send(JSON.stringify({ type: "peer-missing" }));
      return;
    }

    try {
      target.send(JSON.stringify({
        type: message.type,
        from: session.id,
        payload: message.payload
      }));
    } catch (_) {
      ws.send(JSON.stringify({ type: "peer-missing" }));
    }
  }

  webSocketClose(ws) {
    const session = ws.deserializeAttachment() || {};

    const peers = this.ctx.getWebSockets().filter(
      (peer) =>
        peer !== ws &&
        peer.readyState === WebSocket.OPEN
    );

    for (const peer of peers) {
      try {
        if (session.role === "presenter") {
          peer.send(JSON.stringify({ type: "presenter-stopped" }));
        }

        peer.send(JSON.stringify({
          type: "peer-left",
          id: session.id
        }));
      } catch (_) {}
    }
  }

  webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch (_) {}
  }
}
