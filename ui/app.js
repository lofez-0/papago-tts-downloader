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
  subtitleHint: $("subtitleHint"),
  importBtn: $("importBtn"),
  importModal: $("importModal"),
  importClose: $("importClose"),
  importInfo: $("importInfo"),
  importHeader: $("importHeader"),
  importTextCol: $("importTextCol"),
  importNameCol: $("importNameCol"),
  importLangCol: $("importLangCol"),
  importPreview: $("importPreview"),
  importNote: $("importNote"),
  importToText: $("importToText"),
  importSave: $("importSave"),
  dropOverlay: $("dropOverlay"),
};

const SUBTITLE_LABEL = { srt: "SRT", lrc: "LRC" };

const settings = {
  mode: "single",
  language: "ko",
  gender: "female",
  speed: 0,
  dir: "",
  autoUpdate: true,
  subtitle: "none",
  ...store.get("settings", {}),
};
if (!LANGUAGE_LABEL[settings.language]) settings.language = "ko";
if (!SUBTITLE_LABEL[settings.subtitle]) settings.subtitle = "none";

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
  setSubtitle(settings.subtitle);
  document.querySelectorAll("[data-subtitle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      setSubtitle(btn.dataset.subtitle);
      saveSettings();
    }),
  );
}

const SUBTITLE_HINT = {
  none: "",
  srt: "문장마다 시간이 표시된 자막(.srt)을 mp3 옆에 함께 저장합니다.",
  lrc: "음악 앱 가사처럼 볼 수 있는 자막(.lrc)을 mp3 옆에 함께 저장합니다.",
};
function setSubtitle(value) {
  settings.subtitle = value;
  setSegment("subtitle", value);
  els.subtitleHint.textContent = SUBTITLE_HINT[value];
  els.subtitleHint.title = SUBTITLE_HINT[value];
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

/** 번호를 붙인 기본 파일 이름: 001_문장 앞부분 */
function numberedName(index, total, text) {
  const width = Math.max(3, String(total).length);
  return `${String(index + 1).padStart(width, "0")}_${excerpt(text, 40).replace(/…$/, "")}`;
}

function addJobs() {
  const raw = els.text.value.trim();
  if (!raw) {
    toast("읽을 텍스트를 입력해 주세요.", true);
    els.text.focus();
    return;
  }
  let jobs;
  if (settings.mode === "lines") {
    const ls = lines();
    jobs = ls.map((line, i) => ({ text: line, fileName: numberedName(i, ls.length, line) }));
  } else {
    jobs = [{ text: raw, fileName: excerpt(raw, 40).replace(/…$/, "") }];
  }
  enqueue(jobs);
}

/**
 * 저장 목록에 넣는다. job: { text, fileName, language? } (언어를 안 주면 현재 설정)
 * 성공하면 true.
 */
function enqueue(jobs) {
  if (!settings.dir) {
    toast("저장 폴더를 먼저 골라 주세요.", true);
    return false;
  }
  if (jobs.length > MAX_LINES) {
    toast(`한 번에 ${MAX_LINES}개까지 저장할 수 있습니다.`, true);
    return false;
  }
  const voice = currentVoice();
  for (const j of jobs) {
    queue.push({
      id: nextId++,
      text: j.text,
      fileName: j.fileName,
      dir: settings.dir,
      ...voice,
      language: j.language || voice.language,
      subtitle: settings.subtitle,
      status: "waiting",
      path: null,
      subtitlePath: null,
      error: null,
    });
  }
  render();
  pump();
  toast(jobs.length === 1 ? "저장을 시작합니다." : `${jobs.length}개 파일 저장을 시작합니다.`);
  return true;
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
    const result = await invoke("save", {
      req: {
        text: job.text,
        language: job.language,
        gender: job.gender,
        speed: job.speed,
        dir: job.dir,
        fileName: job.fileName,
        subtitle: job.subtitle,
      },
    });
    job.path = result.path;
    job.subtitlePath = result.subtitlePath;
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
  const parts = [voice];
  if (job.subtitle && SUBTITLE_LABEL[job.subtitle]) parts.push(`자막 ${SUBTITLE_LABEL[job.subtitle]}`);
  if (job.path) parts.push(job.path.split(/[\\/]/).pop());
  info.textContent = parts.join(" · ");
  if (job.path) info.title = job.subtitlePath ? `${job.path}\n${job.subtitlePath}` : job.path;
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

// ---------- 완료 알림 (오른쪽 아래, 오른쪽→왼쪽으로 들어왔다가 다시 오른쪽으로 사라짐) ----------
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

// ---------- 파일 불러오기 (txt → 텍스트 칸, csv/tsv → 표 불러오기 창) ----------
const IMPORT_EXTENSIONS = ["txt", "csv", "tsv"];
const HEADER_NAMES = {
  text: ["텍스트", "문장", "내용", "단어", "읽을 텍스트", "text", "sentence", "word", "content"],
  name: ["파일명", "파일 이름", "파일이름", "이름", "filename", "file", "name"],
  lang: ["언어", "language", "lang"],
};
// 언어 칸에 적힌 값 → 언어 코드
const LANGUAGE_ALIASES = (() => {
  const map = {};
  const add = (code, ...names) => names.forEach((n) => (map[n.toLowerCase().replace(/\s+/g, "")] = code));
  for (const [code, label] of LANGUAGES) add(code, code, label);
  add("ko", "한국어", "한글", "korean", "kr", "kor");
  add("en", "영어", "english", "eng");
  add("ja", "일본어", "japanese", "jp", "jpn");
  add("zh-CN", "중국어", "간체", "중국어간체", "chinese", "zh", "zh-cn", "zh-hans");
  add("zh-TW", "번체", "중국어번체", "대만어", "zh-tw", "zh-hant");
  add("es", "스페인어", "spanish");
  add("fr", "프랑스어", "french");
  add("de", "독일어", "german");
  add("ru", "러시아어", "russian");
  add("th", "태국어", "thai");
  return map;
})();
function languageCode(value) {
  return LANGUAGE_ALIASES[String(value || "").toLowerCase().replace(/\s+/g, "")] || null;
}

/** 따옴표를 지원하는 CSV/TSV 파서 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell); cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows
    .map((r) => r.map((v) => v.trim()))
    .filter((r) => r.some((v) => v !== ""));
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const count = (ch) => first.split(ch).length - 1;
  const candidates = [["\t", count("\t")], [",", count(",")], [";", count(";")]];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ",";
}

function findHeader(row, names) {
  const norm = (v) => v.toLowerCase().replace(/\s+/g, "");
  const wanted = names.map(norm);
  return row.findIndex((v) => wanted.includes(norm(v)));
}

const importState = { rows: [], fileName: "", columns: 0 };

async function importPath(path) {
  const name = path.split(/[\\/]/).pop();
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!IMPORT_EXTENSIONS.includes(ext)) {
    toast("txt, csv, tsv 파일만 불러올 수 있습니다.", true);
    return;
  }
  let text;
  try {
    text = await invoke("read_text_file", { path });
  } catch (e) {
    toast(errorText(e), true);
    return;
  }
  if (ext === "txt") importTxt(text, name);
  else openTableImport(text, ext === "tsv" ? "\t" : detectDelimiter(text), name);
}

function importTxt(text, name) {
  const body = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!body.trim()) {
    toast(`'${name}' 파일이 비어 있습니다.`, true);
    return;
  }
  const current = els.text.value.replace(/\s+$/, "");
  els.text.value = current ? `${current}\n${body}` : body;
  updateCounter();
  const n = body.split("\n").filter((l) => l.trim()).length;
  toast(`'${name}' 파일을 ${current ? "이어서 " : ""}불러왔습니다 (${n}줄).`);
}

function openTableImport(text, delimiter, name) {
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) {
    toast(`'${name}' 파일에 내용이 없습니다.`, true);
    return;
  }
  importState.rows = rows;
  importState.fileName = name;
  importState.columns = Math.max(...rows.map((r) => r.length));

  // 첫 줄에 알려진 열 이름이 있으면 제목 줄로 보고 열을 자동으로 고른다.
  const first = rows[0];
  const textIdx = findHeader(first, HEADER_NAMES.text);
  const nameIdx = findHeader(first, HEADER_NAMES.name);
  const langIdx = findHeader(first, HEADER_NAMES.lang);
  const hasHeader = textIdx >= 0 || nameIdx >= 0 || langIdx >= 0;
  els.importHeader.checked = hasHeader;
  fillColumnSelects();
  els.importTextCol.value = String(textIdx >= 0 ? textIdx : guessTextColumn(hasHeader ? rows.slice(1) : rows));
  els.importNameCol.value = String(nameIdx);
  els.importLangCol.value = String(langIdx);
  renderImportPreview();
  els.importModal.hidden = false;
}

/** 제목 줄이 없을 때: 평균 글자 수가 가장 긴 열을 읽을 텍스트로 본다. */
function guessTextColumn(rows) {
  let best = 0;
  let bestLen = -1;
  for (let c = 0; c < importState.columns; c++) {
    const len = rows.reduce((s, r) => s + (r[c] || "").length, 0);
    if (len > bestLen) { best = c; bestLen = len; }
  }
  return best;
}

function fillColumnSelects() {
  const header = els.importHeader.checked ? importState.rows[0] : null;
  const sample = importState.rows[header ? 1 : 0] || [];
  const label = (c) => {
    const title = header ? header[c] : sample[c];
    return `${c + 1}열${title ? `: ${excerpt(title, 16)}` : ""}`;
  };
  const fill = (select, noneLabel) => {
    const keep = select.value;
    select.replaceChildren();
    if (noneLabel) select.add(new Option(noneLabel, "-1"));
    for (let c = 0; c < importState.columns; c++) select.add(new Option(label(c), String(c)));
    if ([...select.options].some((o) => o.value === keep)) select.value = keep;
  };
  fill(els.importTextCol, null);
  fill(els.importNameCol, "없음 (번호_문장으로 자동)");
  fill(els.importLangCol, `없음 (지금 설정: ${LANGUAGE_LABEL[settings.language]})`);
}

/** 고른 열로 저장할 항목 목록을 만든다. */
function importItems() {
  const rows = els.importHeader.checked ? importState.rows.slice(1) : importState.rows;
  const t = Number(els.importTextCol.value);
  const n = Number(els.importNameCol.value);
  const l = Number(els.importLangCol.value);
  const items = [];
  let unknownLang = 0;
  const withText = rows.filter((r) => (r[t] || "").trim());
  withText.forEach((r, i) => {
    const text = r[t].trim();
    let language = null;
    if (l >= 0 && (r[l] || "").trim()) {
      language = languageCode(r[l]);
      if (!language) unknownLang++;
    }
    const given = n >= 0 ? (r[n] || "").trim() : "";
    items.push({
      text,
      fileName: given || numberedName(i, withText.length, text),
      autoName: !given,
      language,
      rawLang: l >= 0 ? (r[l] || "").trim() : "",
    });
  });
  return { items, skipped: rows.length - withText.length, unknownLang };
}

function renderImportPreview() {
  const { items, skipped, unknownLang } = importItems();
  els.importInfo.textContent = `'${importState.fileName}' · ${importState.rows.length}줄, ${importState.columns}열`;
  const frag = document.createDocumentFragment();
  items.slice(0, 8).forEach((it, i) => {
    const tr = document.createElement("tr");
    const cells = [
      [String(i + 1)],
      [it.fileName, it.autoName ? "auto" : ""],
      [it.text],
      it.rawLang
        ? [it.language ? LANGUAGE_LABEL[it.language] : `${it.rawLang} (알 수 없음)`, it.language ? "" : "warn"]
        : [LANGUAGE_LABEL[settings.language], "auto"],
    ];
    for (const [value, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      td.title = value;
      if (cls) td.className = cls;
      tr.append(td);
    }
    frag.append(tr);
  });
  els.importPreview.replaceChildren(frag);

  const notes = [];
  if (items.length > 8) notes.push(`미리보기는 8개까지만 보여 줍니다 (전체 ${items.length}개).`);
  if (skipped) notes.push(`텍스트가 빈 ${skipped}줄은 건너뜁니다.`);
  if (unknownLang) notes.push(`언어를 알 수 없는 ${unknownLang}줄은 지금 설정한 언어로 읽습니다.`);
  if (items.length > MAX_LINES) notes.push(`한 번에 ${MAX_LINES}개까지 저장할 수 있습니다.`);
  els.importNote.textContent = notes.join(" ");
  els.importSave.textContent = `${items.length}개 바로 저장`;
  els.importSave.disabled = items.length === 0 || items.length > MAX_LINES;
  els.importToText.disabled = items.length === 0;
}

function initImport() {
  els.importBtn.addEventListener("click", async () => {
    try {
      const picked = await dialog.open({
        multiple: false,
        filters: [{ name: "텍스트 · 표 (txt, csv, tsv)", extensions: IMPORT_EXTENSIONS }],
      });
      if (typeof picked === "string" && picked) importPath(picked);
    } catch (e) {
      toast(errorText(e), true);
    }
  });
  els.importHeader.addEventListener("change", () => {
    fillColumnSelects();
    renderImportPreview();
  });
  for (const s of [els.importTextCol, els.importNameCol, els.importLangCol]) {
    s.addEventListener("change", renderImportPreview);
  }
  const close = () => (els.importModal.hidden = true);
  els.importClose.addEventListener("click", close);
  els.importModal.addEventListener("click", (e) => {
    if (e.target === els.importModal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.importModal.hidden) close();
  });
  els.importToText.addEventListener("click", () => {
    const { items } = importItems();
    importTxt(items.map((it) => it.text).join("\n"), importState.fileName);
    // 표의 한 줄이 파일 하나가 되도록 '줄마다 따로'로 바꾼다.
    if (settings.mode !== "lines") document.querySelector('[data-mode="lines"]').click();
    close();
  });
  els.importSave.addEventListener("click", () => {
    const { items } = importItems();
    if (enqueue(items.map(({ text, fileName, language }) => ({ text, fileName, language })))) close();
  });

  // 창에 파일을 끌어다 놓기 (Tauri가 파일 경로를 알려 준다)
  const webview = window.__TAURI__.webview?.getCurrentWebview?.();
  webview?.onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") {
      els.dropOverlay.hidden = false;
    } else if (p.type === "leave") {
      els.dropOverlay.hidden = true;
    } else if (p.type === "drop") {
      els.dropOverlay.hidden = true;
      const paths = p.paths || [];
      if (!paths.length) return;
      if (paths.length > 1) toast("한 번에 파일 하나만 불러옵니다. 첫 번째 파일을 불러옵니다.");
      importPath(paths[0]);
    }
  });
}

// ---------- 시작 ----------
initOptions();
initDir();
initSettings();
initImport();
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
