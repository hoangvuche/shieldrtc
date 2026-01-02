<?php 
session_start();

$_SESSION['module'] = 'meeting';
?>

<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>ShieldRTC Private Conference</title>
  <link rel="shortcut icon" type=“image/x-icon” href="assets/images/favicon.png">
  <script src="https://unpkg.com/livekit-client/dist/livekit-client.umd.js"></script>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined&display=block" />
  <link rel="stylesheet" type="text/css" href="<?=asset("assets/css/meeting.css")?>">

  <!-- meeting_v2.2: + support multi device
  meeting_v2.3: + support screen map -->
  <script src="<?=asset("assets/js/meeting_v2.3.js")?>"></script>
  
</head>
<body class="app">
<div class="bg-grid" aria-hidden="true"></div>

  <header class="topbar">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 2.5l7.5 3.6v6.4c0 5.4-3.2 9.2-7.5 10.9C7.7 21.7 4.5 17.9 4.5 12.5V6.1L12 2.5z"
                stroke="rgba(255,255,255,0.92)" stroke-width="1.4" />
          <path d="M8.2 12.2l2.3 2.5 5.3-5.7"
                stroke="rgba(76,201,240,0.95)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="brandText">
        <div class="name">ShieldRTC</div>
        <div class="sub">Private conference · Ephemeral · Zero retention</div>
      </div>
    </div>

    <div class="topbarRight">
      <div id="topbarRoom" class="chip">
        <span class="dot"></span>
        <span class="chipText">Not connected</span>
      </div>
      <div class="chip chip-muted">
        <span class="material-symbols-outlined" style="font-size:18px;">group</span>
        <span id="topbarCount">0</span>
      </div>
    </div>
  </header>

  <main class="layout">
    <aside class="side">

      <section class="card pad">
        <div class="cardHead">
          <h3>Access</h3>
          <div class="pill"><span class="spark"></span>No storage by design</div>
        </div>

        <div class="fieldGrid">
          <div class="fieldRow">
            <input type="text" id="username" placeholder="Username">
            <input type="password" id="password" placeholder="Password">
          </div>

          <button id="loginBtn" class="btn-primary">Login</button>
        </div>

        <div class="hint">
          Login is only used to mint a short-lived token. Messages and media are never stored on ShieldRTC servers.
        </div>
      </section>

      <section class="card pad">
        <div class="cardHead">
          <h3>Room</h3>
          <div class="pill">
            <span class="material-symbols-outlined" style="font-size:18px;">lock</span>
            Ephemeral
          </div>
        </div>

        <div class="fieldGrid">
          <button id="createRoomBtn" class="btn-primary" disabled>Create room</button>

          <div id="createdRoom" class="section">
            <span style="color:var(--muted); font-size:12px;">Created</span>
            <span id="createdRoomId" class="inlineCode"></span>
            <button id="copyRoom" class="icon-btn" title="Copy room ID">
              <span class="material-symbols-outlined">content_copy</span>
            </button>
          </div>

          <div class="hr"></div>

          <div id="joinSection" class="section">
            <input type="text" id="roomId" placeholder="Enter room ID">
            <button id="joinBtn" class="btn-primary" disabled>Join</button>
            <button id="endBtn" class="btn-danger" disabled>End</button>
            <button id="destroyBtn" class="btn-danger btn-danger--outline" title="Disband room" disabled>Disband</button>
            <button id="copyRoomJoin" class="icon-btn icon-btn--subtle" title="Copy room ID">
              <span class="material-symbols-outlined">content_copy</span>
            </button>
          </div>
        </div>

        <div class="hint">
          Share your <span class="inlineCode">Room ID</span> with others. Screen share is single-owner to keep the stage clean.
        </div>
      </section>

      <section class="card pad" id="sideControlsCard">
        <div class="cardHead">
          <h3>Controls</h3>
          <div class="pill">
            <span class="material-symbols-outlined" style="font-size:18px;">bolt</span>
            Low bandwidth
          </div>
        </div>

        <div id="mediaWrapper" class="controlDock stageControlDock">
          <div class="dockLeft">

            <button id="toggleCameraBtn" class="icon-btn" disabled title="Turn camera off">
              <span class="material-symbols-outlined">videocam</span>
            </button>

            <button id="switchCameraBtn" class="icon-btn" disabled title="Switch camera">
              <span class="material-symbols-outlined">switch_camera</span>
            </button>

            <button id="toggleScreenBtn" class="icon-btn" disabled title="Share screen">
              <span class="material-symbols-outlined">screen_share</span>
            </button>

            <button id="toggleSpeakerBtn" class="icon-btn" disabled title="Mute call audio">
              <span class="material-symbols-outlined">volume_up</span>
            </button>

            <button id="toggleMicBtn" class="icon-btn sensitive-btn" disabled title="Mute microphone">
              <span class="material-symbols-outlined">mic</span>
            </button>

          </div>

          <div class="dockRight">
            <button id="openChatBtn" class="icon-btn icon-btn--subtle" title="Open chat">
              <span class="material-symbols-outlined">chat</span>
            </button>
            <button id="stageFsBtn" class="icon-btn icon-btn--subtle" title="Enter fullscreen">
              <span class="material-symbols-outlined">fullscreen</span>
            </button>
          </div>
        </div>

        <div class="hint">
          When you share your screen, your camera pauses automatically to save bandwidth.
        </div>
      </section>

    </aside>

    <section class="main">

      <section class="card stageCard">
        <div class="stageHead">
          <div class="title">Stage</div>
          <div class="meta">
            <span>Active speaker gets a highlight border.</span>
          </div>
        </div>

        <div class="stageWrap">
          <div id="stage" class="stage">
            <div id="screenPane" class="pane screen-pane">
              <div id="screenSlot" class="screen-slot"></div>

              <!-- Context controls (only zoom shows when a screen share is active) -->
              <div id="stageQuickControls" class="screen-zoom-controls" aria-label="Stage controls">
                <button id="zoomOutBtn" class="zoom-btn is-hidden" title="Zoom out">
                  <span class="material-symbols-outlined">zoom_out</span>
                </button>
                <button id="zoomInBtn" class="zoom-btn is-hidden" title="Zoom in">
                  <span class="material-symbols-outlined">zoom_in</span>
                </button>
              </div>
            </div>

            <div id="splitter" class="splitter" title="Drag to resize"></div>
            <div id="usersPane" class="pane users-pane">
              <div id="videos" class="tiles"></div>
            </div>
            <div id="chatPane" class="pane chat-pane is-hidden">
              <div id="chatDockMount"></div>
            </div>
          </div>
        </div>

        <div class="stageControlsWrap">
          <div id="stageControlsMount"></div>
          <div class="hint stageControlsHint">
            When you share your screen, your camera pauses automatically to save bandwidth.
          </div>
        </div>
      </section>

      <div id="chatNormalMount">
      <section id="chatCard" class="card pad">
        <div class="cardHead">
          <h3>Ephemeral chat</h3>
          <div class="pill"><span class="spark"></span>Not stored</div>
        </div>

        <div id="chatBox" class="chatBox"></div>

        <div id="sendWrapper" class="sendBar">
          <input type="text" id="chatInput" placeholder="Type a message">
          <button id="sendChatBtn" class="btn-with-icon btn-primary" disabled>
            <span class="material-symbols-outlined">send</span>
            Send
          </button>
        </div>
      </section>
      </div>

    </section>
  </main>
</body>
</html>