"use strict";

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

// 파파고가 지원하는 TTS 언어 (백엔드의 화자 표와 같아야 함)
const LANGUAGES = [
  ["ko", "한국어"],
  ["en", "영어"],
  ["ja", "일본어"],
  ["zh-CN", "중국어 (간체)"],
  ["zh-TW", "중국어 (번체)"],
  ["es", "스페인어"],
  ["fr", "프랑스어"],
  ["de", "독일어"],
  ["ru", "러시아어"],
  ["th", "태국어"],
];
const LANGUAGE_LABEL = Object.fromEntries(LANGUAGES);
const SPEED_LABEL = { 5: "아주 느리게", 3: "느리게", 0: "보통", "-2": "빠르게" };

const CONCURRENCY = 2;          // 동시에 받는 개수 (서비스 부담을 줄이려고 낮게 둔다)
const MAX_LINES = 300;          // 한 번에 넣을 수 있는 줄 수
const DISCLAIMER_KEY = "disclaimer-agreed-v1";
const PENDING_UPDATE_KEY = "pending-update"; // 업데이트 직후 알림용 {from, to}

// ---------- 저장소 (실패해도 동작하도록) ----------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 무시 */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* 무시 */ }
  },
};

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"),
  counter: $("counter"),
  language: $("language"),
  speed: $("speed"),
  dir: $("dir"),
  pickDir: $("pickDir"),
  openDir: $("openDir"),
  previewBtn: $("previewBtn"),
  downloadBtn: $("downloadBtn"),
  queueList: $("queueList"),
  queueCount: $("queueCount"),
  emptyState: $("emptyState"),
  clearDone: $("clearDone"),
  toast: $("toast"),
  modal: $("modal"),
  agreeRow: $("agreeRow"),
  agreeCheck: $("agreeCheck"),
  modalClose: $("modalClose"),
  infoBtn: $("infoBtn"),
  settingsBtn: $("settingsBtn"),
  settingsModal: $("settingsModal"),
  settingsClose: $("settingsClose"),
  versionText: $("versionText"),
  updateStatus: $("updateStatus"),
  autoUpdate: $("autoUpdate"),
  manualRow: $("manualRow"),
  checkUpdateBtn: $("checkUpdateBtn"),
  updateModal: $("updateModal"),
  updateTitle: $("updateTitle"),
  updFrom: $("updFrom"),
  updTo: $("updTo"),
  updNotes: $("updNotes"),
  updProgress: $("updProgress"),
  updMessage: $("updMessage"),
  updActions: $("updActions"),
  updLater: $("updLater"),
  updNow: $("updNow"),
  notify: $("notify"),
  notifyTitle: $("notifyTitle"),
  notifyBody: $("notifyBody"),
};

const settings = {
  mode: "single",
  language: "ko",
  gender: "female",
  speed: 0,
  dir: "",
  autoUpdate: true,
  ...store.get("settings", {}),
};
if (!LANGUAGE_LABEL[settings.language]) settings.language = "ko";

function saveSettings() {
  store.set("settings", settings);
}

// ---------- 토스트 ----------
let toastTimer;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), isError ? 5000 : 2500);
}

function errorText(e) {
  return typeof e === "string" ? e : (e && e.message) || String(e);
}

// ---------- 오디오 재생 ----------
const player = new Audio();
let playerUrl = null;
function playBytes(buffer) {
  player.pause();
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(new Blob([buffer], { type: "audio/mpeg" }));
  player.src = playerUrl;
  return player.play();
}

// ---------- 옵션 UI ----------
function setSegment(attr, value) {
  document.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset[attr] === value));
  });
}

function initOptions() {
  for (const [code, label] of LANGUAGES) {
    els.language.add(new Option(label, code));
  }
  els.language.value = settings.language;
  els.speed.value = String(settings.speed);
  setSegment("mode", settings.mode);
  setSegment("gender", settings.gender);

  els.language.addEventListener("change", () => {
    settings.language = els.language.value;
    saveSettings();
  });
  els.speed.addEventListener("change", () => {
    settings.speed = Number(els.speed.value);
    saveSettings();
  });
  document.querySelectorAll("[data-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      settings.mode = btn.dataset.mode;
      setSegment("mode", settings.mode);
      saveSettings();
      updateCounter();
    }),
  );
  document.querySelectorAll("[data-gender]").forEach((btn) =>
    btn.addEventListener("click", () => {
      settings.gender = btn.dataset.gender;
      setSegment("gender", settings.gender);
      saveSettings();
    }),
  );
}

async function initDir() {
  if (!settings.dir) {
    try {
      settings.dir = await invoke("default_dir");
      saveSettings();
    } catch { /* 사용자가 직접 고르면 됨 */ }
  }
  els.dir.value = settings.dir;
  els.dir.title = settings.dir;

  els.pickDir.addEventListener("click", async () => {
    try {
      const picked = await dialog.open({ directory: true, defaultPath: settings.dir || undefined });
      if (typeof picked === "string" && picked) {
        settings.dir = picked;
        els.dir.value = picked;
        els.dir.title = picked;
        saveSettings();
      }
    } catch (e) {
      toast(errorText(e), true);
    }
  });
  els.openDir.addEventListener("click", () =>
    invoke("reveal", { path: settings.dir }).catch((e) => toast(errorText(e), true)),
  );
}

// ---------- 입력 ----------
function lines() {
  return els.text.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function updateCounter() {
  const chars = els.text.value.trim().length;
  if (settings.mode === "lines") {
    els.counter.textContent = `${chars.toLocaleString()}자 · ${lines().length}줄 → 파일 ${lines().length}개`;
  } else {
    els.counter.textContent = `${chars.toLocaleString()}자`;
  }
}

function excerpt(text, max = 30) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function currentVoice() {
  return { language: settings.language, gender: settings.gender, speed: settings.speed };
}

// ---------- 다운로드 목록 ----------
let nextId = 1;
const queue = [];
let active = 0;

function addJobs() {
  const raw = els.text.value.trim();
  if (!raw) {
    toast("읽을 텍스트를 입력해 주세요.", true);
    els.text.focus();
    return;
  }
  if (!settings.dir) {
    toast("저장 폴더를 먼저 골라 주세요.", true);
    return;
  }

  const voice = currentVoice();
  let jobs;
  if (settings.mode === "lines") {
    const ls = lines();
    if (ls.length > MAX_LINES) {
      toast(`한 번에 ${MAX_LINES}줄까지 넣을 수 있습니다.`, true);
      return;
    }
    const width = Math.max(3, String(ls.length).length);
    jobs = ls.map((line, i) => ({
      text: line,
      fileName: `${String(i + 1).padStart(width, "0")}_${excerpt(line, 40).replace(/…$/, "")}`,
    }));
  } else {
    jobs = [{ text: raw, fileName: excerpt(raw, 40).replace(/…$/, "") }];
  }

  for (const j of jobs) {
    queue.push({
      id: nextId++,
      text: j.text,
      fileName: j.fileName,
      dir: settings.dir,
      ...voice,
      status: "waiting",
      path: null,
      error: null,
    });
  }
  render();
  pump();
  toast(jobs.length === 1 ? "저장을 시작합니다." : `${jobs.length}개 파일 저장을 시작합니다.`);
}

function pump() {
  while (active < CONCURRENCY) {
    const job = queue.find((j) => j.status === "waiting");
    if (!job) break;
    run(job);
  }
}

async function run(job) {
  active++;
  job.status = "working";
  job.error = null;
  render();
  try {
    job.path = await invoke("save", {
      req: {
        text: job.text,
        language: job.language,
        gender: job.gender,
        speed: job.speed,
        dir: job.dir,
        fileName: job.fileName,
      },
    });
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = errorText(e);
  } finally {
    active--;
    render();
    pump();
    if (active === 0 && !queue.some((j) => j.status === "waiting")) {
      const failed = queue.filter((j) => j.status === "error").length;
      if (failed) toast(`저장하지 못한 항목이 ${failed}개 있습니다.`, true);
    }
  }
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
};
const STATUS_LABEL = { waiting: "대기", working: "받는 중", done: "완료", error: "실패" };

function iconButton(kind, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = ICONS[kind];
  b.addEventListener("click", onClick);
  return b;
}

function renderItem(job) {
  const li = document.createElement("li");
  li.className = `item ${job.status}`;

  const text = document.createElement("div");
  text.className = "item-text";
  text.textContent = excerpt(job.text, 80);
  text.title = job.text;

  const sub = document.createElement("div");
  sub.className = "item-sub";
  const chip = document.createElement("span");
  chip.className = `chip ${job.status}`;
  chip.textContent = STATUS_LABEL[job.status];
  const info = document.createElement("span");
  info.className = "path";
  const voice = `${LANGUAGE_LABEL[job.language]} · ${job.gender === "female" ? "여성" : "남성"} · ${SPEED_LABEL[job.speed]}`;
  info.textContent = job.path ? `${voice} · ${job.path.split(/[\\/]/).pop()}` : voice;
  if (job.path) info.title = job.path;
  sub.append(chip, info);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (job.status === "done") {
    actions.append(
      iconButton("play", "재생", async () => {
        try {
          await playBytes(await invoke("read_audio", { path: job.path }));
        } catch (e) {
          toast(errorText(e), true);
        }
      }),
      iconButton("folder", "폴더에서 보기", () =>
        invoke("reveal", { path: job.path }).catch((e) => toast(errorText(e), true)),
      ),
    );
  }
  if (job.status === "error") {
    actions.append(
      iconButton("retry", "다시 시도", () => {
        job.status = "waiting";
        job.error = null;
        render();
        pump();
      }),
    );
  }
  if (job.status !== "working") {
    actions.append(
      iconButton("remove", "목록에서 지우기", () => {
        queue.splice(queue.indexOf(job), 1);
        render();
      }),
    );
  }

  li.append(text, sub, actions);
  if (job.error) {
    const err = document.createElement("div");
    err.className = "item-error";
    err.textContent = job.error;
    li.append(err);
  }
  return li;
}

function render() {
  // 최근 항목이 위로 오게
  const frag = document.createDocumentFragment();
  for (let i = queue.length - 1; i >= 0; i--) frag.append(renderItem(queue[i]));
  els.queueList.replaceChildren(frag);

  els.emptyState.hidden = queue.length > 0;
  const done = queue.filter((j) => j.status === "done").length;
  els.queueCount.textContent = queue.length ? `(${done}/${queue.length})` : "";
  els.clearDone.hidden = done === 0;
}

// ---------- 미리듣기 ----------
async function preview() {
  const text = settings.mode === "lines" ? lines()[0] : els.text.value.trim();
  if (!text) {
    toast("읽을 텍스트를 입력해 주세요.", true);
    els.text.focus();
    return;
  }
  const label = els.previewBtn.querySelector("span");
  els.previewBtn.disabled = true;
  label.textContent = "불러오는 중…";
  try {
    const bytes = await invoke("preview", { req: { text, ...currentVoice() } });
    await playBytes(bytes);
    if (settings.mode === "lines" && lines().length > 1) toast("첫 줄만 미리 들려 드립니다.");
  } catch (e) {
    toast(errorText(e), true);
  } finally {
    els.previewBtn.disabled = false;
    label.textContent = "미리듣기";
  }
}

// ---------- 면책 고지 ----------
function showDisclaimer(firstRun) {
  els.agreeRow.hidden = !firstRun;
  els.agreeCheck.checked = false;
  els.modalClose.disabled = firstRun;
  els.modalClose.textContent = firstRun ? "동의하고 시작" : "닫기";
  els.modal.dataset.firstRun = String(firstRun);
  els.modal.hidden = false;
}

// 동의를 마친 뒤(이미 동의했다면 바로) onReady를 부른다.
function initDisclaimer(onReady) {
  els.agreeCheck.addEventListener("change", () => {
    els.modalClose.disabled = !els.agreeCheck.checked;
  });
  els.modalClose.addEventListener("click", () => {
    const firstRun = els.modal.dataset.firstRun === "true";
    if (firstRun) store.set(DISCLAIMER_KEY, true);
    els.modal.hidden = true;
    if (firstRun) onReady();
  });
  els.infoBtn.addEventListener("click", () => showDisclaimer(false));
  if (store.get(DISCLAIMER_KEY, false)) onReady();
  else showDisclaimer(true);
}

// ---------- 완료 알림 (오른쪽 아래, 왼쪽→오른쪽으로 들어왔다가 다시 왼쪽으로 사라짐) ----------
let notifyTimer;
function showNotify(title, body, duration = 4500) {
  const n = els.notify;
  clearTimeout(notifyTimer);
  els.notifyTitle.textContent = title;
  els.notifyBody.textContent = body;
  n.hidden = false;
  n.classList.remove("leave", "enter");
  void n.offsetWidth; // 애니메이션을 처음부터 다시 시작
  n.classList.add("enter");
  notifyTimer = setTimeout(() => {
    n.classList.remove("enter");
    n.classList.add("leave");
    n.addEventListener("animationend", () => {
      if (n.classList.contains("leave")) n.hidden = true;
    }, { once: true });
  }, duration);
}

// ---------- 설정 · 업데이트 ----------
let currentVersion = "";
let updateBusy = false; // 확인 또는 설치 중
let installing = false;

function setUpdateStatus(text) {
  els.updateStatus.textContent = text;
}

function openSettings() {
  els.settingsModal.hidden = false;
}
function closeSettings() {
  els.settingsModal.hidden = true;
}

function applyAutoUpdateUi() {
  els.autoUpdate.checked = settings.autoUpdate;
  // 자동 업데이트를 끄면 수동 업데이트 버튼이 나타난다.
  els.manualRow.hidden = settings.autoUpdate;
}

async function initVersion() {
  try {
    currentVersion = await invoke("app_version");
  } catch {
    currentVersion = "";
  }
  els.versionText.textContent = currentVersion ? `v${currentVersion}` : "알 수 없음";

  // 업데이트를 설치하고 다시 실행된 경우 알림을 띄운다.
  const pending = store.get(PENDING_UPDATE_KEY, null);
  if (pending) {
    store.remove(PENDING_UPDATE_KEY);
    if (currentVersion && pending.to === currentVersion) {
      setUpdateStatus(`v${pending.from}에서 업데이트했습니다.`);
      setTimeout(() => showNotify("업데이트 완료", `v${currentVersion} 버전으로 업데이트했습니다.`), 400);
    }
  }
}

function showUpdateModal(info, { auto }) {
  els.updateTitle.textContent = auto ? "새 버전을 설치하고 있습니다" : "새 버전이 있습니다";
  els.updFrom.textContent = `v${info.currentVersion}`;
  els.updTo.textContent = `v${info.version}`;
  els.updNotes.textContent = info.notes || "";
  els.updProgress.hidden = true;
  els.updMessage.textContent = auto ? "" : "지금 업데이트하면 설치가 끝난 뒤 프로그램이 다시 시작됩니다.";
  els.updActions.hidden = auto;
  els.updNow.textContent = "지금 업데이트";
  els.updateModal.dataset.version = info.version;
  els.updateModal.dataset.from = info.currentVersion;
  els.updateModal.hidden = false;
  if (!auto) els.updNow.focus();
}

function setProgress(downloaded, total) {
  const bar = els.updProgress.querySelector(".bar");
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  els.updProgress.hidden = false;
  if (total) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    els.updProgress.classList.remove("indeterminate");
    bar.style.width = `${pct}%`;
    els.updMessage.textContent = pct >= 100
      ? "설치 프로그램을 실행합니다. 잠시 후 프로그램이 다시 시작됩니다."
      : `받는 중… ${pct}% (${mb(downloaded)} / ${mb(total)} MB)`;
  } else {
    els.updProgress.classList.add("indeterminate");
    els.updMessage.textContent = `받는 중… ${mb(downloaded)} MB`;
  }
}

async function installUpdate() {
  if (installing) return;
  if (active > 0 || queue.some((j) => j.status === "waiting")) {
    toast("저장이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.", true);
    return;
  }
  installing = true;
  updateBusy = true;
  const to = els.updateModal.dataset.version;
  const from = els.updateModal.dataset.from;
  els.updActions.hidden = true;
  els.updProgress.hidden = false;
  els.updProgress.classList.add("indeterminate");
  els.updMessage.textContent = "새 버전을 받는 중…";
  // 다시 실행되었을 때 "업데이트 완료" 알림을 띄우려고 미리 적어 둔다.
  store.set(PENDING_UPDATE_KEY, { from, to });
  try {
    await invoke("install_update"); // Windows에서는 설치 단계에서 프로그램이 종료된다.
  } catch (e) {
    store.remove(PENDING_UPDATE_KEY);
    els.updateTitle.textContent = "업데이트하지 못했습니다";
    els.updProgress.hidden = true;
    els.updMessage.textContent = errorText(e);
    els.updActions.hidden = false;
    els.updNow.textContent = "다시 시도";
    setUpdateStatus("업데이트를 설치하지 못했습니다.");
  } finally {
    installing = false;
    updateBusy = false;
  }
}

async function retryInstall() {
  // 실패한 뒤에는 업데이트를 다시 확인해야 설치할 수 있다.
  if (els.updNow.textContent === "다시 시도") {
    els.updateModal.hidden = true;
    await checkForUpdate({ auto: false });
    return;
  }
  installUpdate();
}

/** auto가 true면 새 버전을 찾는 즉시 설치하고, 아니면 사용자가 고르게 한다. */
async function checkForUpdate({ auto }) {
  if (updateBusy) return;
  updateBusy = true;
  els.checkUpdateBtn.disabled = true;
  els.checkUpdateBtn.textContent = "확인 중…";
  setUpdateStatus("업데이트를 확인하는 중…");
  let info = null;
  try {
    info = await invoke("check_update");
    if (info) {
      setUpdateStatus(`새 버전이 있습니다: v${info.version}`);
    } else {
      setUpdateStatus("최신 버전을 쓰고 있습니다.");
      if (!auto) toast("최신 버전을 쓰고 있습니다.");
    }
  } catch (e) {
    setUpdateStatus(auto ? "자동 업데이트 확인에 실패했습니다." : errorText(e));
    if (!auto) toast(errorText(e), true);
  } finally {
    updateBusy = false;
    els.checkUpdateBtn.disabled = false;
    els.checkUpdateBtn.textContent = "업데이트 확인";
  }
  if (info) {
    closeSettings();
    showUpdateModal(info, { auto });
    if (auto) installUpdate();
  }
}

function initSettings() {
  applyAutoUpdateUi();
  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });
  els.autoUpdate.addEventListener("change", () => {
    settings.autoUpdate = els.autoUpdate.checked;
    saveSettings();
    applyAutoUpdateUi();
    toast(settings.autoUpdate ? "자동 업데이트를 켰습니다. 다음 실행부터 적용됩니다." : "자동 업데이트를 껐습니다.");
  });
  els.checkUpdateBtn.addEventListener("click", () => checkForUpdate({ auto: false }));
  els.updLater.addEventListener("click", () => {
    els.updateModal.hidden = true;
  });
  els.updNow.addEventListener("click", retryInstall);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.settingsModal.hidden) closeSettings();
    else if (!els.updateModal.hidden && !installing && !els.updActions.hidden) els.updateModal.hidden = true;
  });
  listen("update-progress", (e) => setProgress(e.payload.downloaded, e.payload.total));
}

// ---------- 시작 ----------
initOptions();
initDir();
initSettings();
initVersion().then(() =>
  initDisclaimer(() => {
    if (settings.autoUpdate) checkForUpdate({ auto: true });
  }),
);
render();
updateCounter();

els.text.addEventListener("input", updateCounter);
els.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    addJobs();
  }
});
els.previewBtn.addEventListener("click", preview);
els.downloadBtn.addEventListener("click", addJobs);
els.clearDone.addEventListener("click", () => {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === "done") queue.splice(i, 1);
  render();
});
// 우클릭 메뉴는 텍스트 입력칸에서만
document.addEventListener("contextmenu", (e) => {
  if (e.target !== els.text) e.preventDefault();
});
