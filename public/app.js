const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const logoutButton = document.querySelector("#logout-button");
const uploadForm = document.querySelector("#upload-form");
const videoInput = document.querySelector("#video-file");
const tierSelect = document.querySelector("#video-tier");
const uploadButton = document.querySelector("#upload-button");
const uploadMessage = document.querySelector("#upload-message");
const dropzone = document.querySelector("#dropzone");
const progressWrap = document.querySelector("#progress-wrap");
const uploadProgress = document.querySelector("#upload-progress");
const linkList = document.querySelector("#link-list");
const resultLink = document.querySelector("#result-link");
const connectionLabel = document.querySelector("#connection-label");

let config;
let busy = false;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

function formatExpiry(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function setSignedIn(signedIn) {
  loginView.hidden = signedIn;
  appView.hidden = !signedIn;
  logoutButton.hidden = !signedIn;
  connectionLabel.textContent = signedIn ? "WORKSPACE READY" : "PASSWORD REQUIRED";
}

function renderTiers() {
  const quotaList = document.querySelector("#quota-list");
  quotaList.replaceChildren();
  tierSelect.replaceChildren();

  for (const tier of config.tiers) {
    const quota = document.createElement("div");
    quota.className = "quota-item";
    quota.innerHTML = `<span class="quota-name"></span><span class="quota-amount"></span><span class="quota-state"></span>`;
    quota.querySelector(".quota-name").textContent = tier.name;
    quota.querySelector(".quota-amount").textContent = `${tier.available} / ${tier.limit}`;
    quota.querySelector(".quota-state").textContent = tier.available ? "AVAILABLE" : "FULL";
    quota.classList.toggle("is-full", tier.available === 0);
    quotaList.append(quota);

    const option = document.createElement("option");
    option.value = tier.id;
    option.textContent = `${tier.name} · ${tier.available} of ${tier.limit} slots`;
    option.disabled = tier.available === 0;
    tierSelect.append(option);
  }
  updateSubmitState();
}

function updateSubmitState() {
  const selected = config?.tiers.find((tier) => tier.id === tierSelect.value);
  uploadButton.disabled = busy || !videoInput.files?.length || !selected || selected.available < 1;
}

function renderUploads(videos) {
  linkList.replaceChildren();
  document.querySelector("#link-count").textContent = String(videos.length).padStart(2, "0");
  if (!videos.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Your active uploads will appear here.";
    linkList.append(empty);
    return;
  }

  for (const video of videos.sort((left, right) => right.createdAt - left.createdAt)) {
    const row = document.createElement("article");
    row.className = "link-row";
    const details = document.createElement("div");
    details.className = "link-details";
    const title = document.createElement("a");
    title.className = "link-title";
    title.href = `/v/${video.id}`;
    title.textContent = video.title;
    const meta = document.createElement("p");
    meta.className = "link-meta";
    meta.textContent = `${video.tier === "day" ? "1 DAY" : video.tier === "week" ? "7 DAYS" : "30 DAYS"} · EXPIRES ${formatExpiry(video.expiresAt)}`;
    details.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "link-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-button";
    copy.textContent = "Copy link";
    copy.title = "Copy share link";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(new URL(`/v/${video.id}`, location.origin).href);
      copy.textContent = "Copied";
      window.setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
    });
    actions.append(copy);
    row.append(details, actions);
    linkList.append(row);
  }
}

async function refreshWorkspace() {
  config = await api("/api/config");
  document.querySelector("#max-size").textContent = formatBytes(config.maxUploadBytes);
  renderTiers();
  const { videos } = await api("/api/uploads");
  renderUploads(videos);
}

function xhrUpload(url, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || "Upload could not be completed."));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    xhr.send(file);
  });
}

async function capturePoster(file) {
  const source = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = source;
  try {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", reject, { once: true });
      video.load();
    });
    const seekTime = Math.min(0.5, Math.max(0, video.duration / 2));
    if (seekTime > 0) {
      await new Promise((resolve, reject) => {
        video.addEventListener("seeked", resolve, { once: true });
        video.addEventListener("error", reject, { once: true });
        video.currentTime = seekTime;
      });
    }
    const scale = Math.min(1, 1200 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(source);
    video.removeAttribute("src");
    video.load();
  }
}

async function loadWorkspace() {
  try {
    await refreshWorkspace();
    setSignedIn(true);
  } catch (error) {
    if (error.message === "Sign in to continue.") {
      setSignedIn(false);
      return;
    }
    connectionLabel.textContent = "OFFLINE";
    setMessage(loginMessage, error.message, true);
    setSignedIn(false);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector("button");
  submit.disabled = true;
  setMessage(loginMessage, "Checking password…");
  try {
    await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: new FormData(loginForm).get("password") }),
    });
    loginForm.reset();
    await loadWorkspace();
  } catch (error) {
    setMessage(loginMessage, error.message, true);
  } finally {
    submit.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  setSignedIn(false);
});

videoInput.addEventListener("change", () => {
  const file = videoInput.files?.[0];
  document.querySelector("#file-label").textContent = file?.name || "Choose a video";
  document.querySelector("#file-subtext").textContent = file ? formatBytes(file.size) : "MP4, WebM, MOV or MKV";
  const title = document.querySelector("#video-title");
  if (file && !title.value) title.value = file.name.replace(/\.[^.]+$/, "").slice(0, 100);
  updateSubmitState();
});

tierSelect.addEventListener("change", updateSubmitState);

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
}
dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  videoInput.files = transfer.files;
  videoInput.dispatchEvent(new Event("change", { bubbles: true }));
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = videoInput.files?.[0];
  if (!file || busy) return;
  if (file.size > config.maxUploadBytes) {
    setMessage(uploadMessage, `This file exceeds the ${formatBytes(config.maxUploadBytes)} limit.`, true);
    return;
  }
  const tier = config.tiers.find((item) => item.id === tierSelect.value);
  if (!tier?.available) {
    setMessage(uploadMessage, "That expiry tier is full. Choose another.", true);
    return;
  }
  if (file.size === 0) {
    setMessage(uploadMessage, "Choose a non-empty video file.", true);
    return;
  }

  busy = true;
  updateSubmitState();
  resultLink.hidden = true;
  progressWrap.hidden = false;
  uploadProgress.value = 0;
  document.querySelector("#progress-value").textContent = "0%";
  setMessage(uploadMessage, "Preparing preview…");
  let shareUrl;
  try {
    const poster = await capturePoster(file);
    setMessage(uploadMessage, "Uploading video…");
    const uploaded = await xhrUpload("/api/upload", file, {
      "Content-Type": file.type || "video/mp4",
      "X-Upload-Tier": tier.id,
      "X-Upload-Title": document.querySelector("#video-title").value,
      "X-Upload-Description": document.querySelector("#video-description").value,
    }, (percent) => {
      uploadProgress.value = percent;
      document.querySelector("#progress-value").textContent = `${percent}%`;
    });
    shareUrl = uploaded.shareUrl;
    if (poster) {
      document.querySelector("#progress-label").textContent = "Saving preview";
      await xhrUpload(`/api/videos/${uploaded.id}/poster`, poster, { "Content-Type": "image/jpeg" }, () => {});
    }
    const anchor = document.createElement("a");
    anchor.href = shareUrl;
    anchor.textContent = shareUrl;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy link";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(shareUrl);
      copy.textContent = "Copied";
    });
    resultLink.replaceChildren(anchor, copy);
    resultLink.hidden = false;
    setMessage(uploadMessage, "Your video is ready to share.");
    uploadForm.reset();
    document.querySelector("#file-label").textContent = "Choose a video";
    document.querySelector("#file-subtext").textContent = "MP4, WebM, MOV or MKV";
    await refreshWorkspace();
  } catch (error) {
    setMessage(uploadMessage, error.message, true);
    if (shareUrl) {
      const anchor = document.createElement("a");
      anchor.href = shareUrl;
      anchor.textContent = "Open the uploaded video";
      resultLink.replaceChildren(anchor);
      resultLink.hidden = false;
    }
  } finally {
    busy = false;
    updateSubmitState();
  }
});

document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date()).toUpperCase();
loadWorkspace();