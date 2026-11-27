// 릴리스용 파일을 만든다.
//
//   npm run release -- --notes "바뀐 내용"            빌드 + dist/release 에 파일 준비
//   npm run release -- --notes "바뀐 내용" --publish  위 작업 후 GitHub 릴리스까지 만들기
//   npm run release -- --notes-file notes.md --publish   여러 줄 설명은 파일로 넘긴다
//                                                        (npm을 거치면 줄바꿈 뒤 인자가 잘린다)
//   --no-build   이미 빌드한 결과물로 파일만 다시 준비한다
//
// 결과 (dist/release/):
//   Papago.TTS.Downloader_<버전>_x64-setup.exe   설치 파일 (자동 업데이트가 내려받는 파일)
//   papago-tts-downloader.exe                    설치 없이 실행하는 파일
//   latest.json                                  자동 업데이트가 읽는 버전 정보
//
// 업데이트 파일은 비밀 키로 서명해야 한다. 기본으로 %USERPROFILE%\.tauri\papago-tts-downloader.key 를 쓰고,
// 다른 곳에 두었다면 TAURI_SIGNING_PRIVATE_KEY 환경 변수에 키 파일 경로나 내용을 넣는다.
// 이 키를 잃어버리면 이미 설치된 프로그램에 업데이트를 보낼 수 없으니 안전한 곳에 백업해 둘 것.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "lofez-0/papago-tts-downloader";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const notesFile = option("--notes-file");
const notes = (notesFile ? readFileSync(resolve(notesFile), "utf8") : option("--notes") ?? "").trim();
const tag = `v${version}`;

// 서명 키
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = join(homedir(), ".tauri", "papago-tts-downloader.key");
  if (!existsSync(keyPath)) {
    console.error(`서명 키가 없습니다: ${keyPath}\nTAURI_SIGNING_PRIVATE_KEY 환경 변수로 키를 지정해 주세요.`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = keyPath;
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

if (flag("--no-build")) {
  console.log(`▶ v${version}: 이미 빌드한 결과물을 씁니다.`);
} else {
  console.log(`▶ v${version} 빌드 중…`);
  execFileSync("npx tauri build", { cwd: root, env, stdio: "inherit", shell: true });
}

const target = env.CARGO_TARGET_DIR ? resolve(env.CARGO_TARGET_DIR) : join(root, "src-tauri", "target");
const release = join(target, "release");
const setupName = `${conf.productName}_${version}_x64-setup.exe`;
const setupPath = join(release, "bundle", "nsis", setupName);
const sigPath = `${setupPath}.sig`;
if (!existsSync(setupPath) || !existsSync(sigPath)) {
  console.error(`설치 파일이나 서명 파일을 찾지 못했습니다:\n  ${setupPath}\n  ${sigPath}`);
  process.exit(1);
}

// GitHub는 첨부 파일 이름의 공백을 점으로 바꾸므로 미리 맞춘다.
const assetName = setupName.replaceAll(" ", ".");
const out = join(root, "dist", "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(setupPath, join(out, assetName));
copyFileSync(join(release, "papago-tts-downloader.exe"), join(out, "papago-tts-downloader.exe"));

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
    },
  },
};
writeFileSync(join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`✔ 준비 완료: ${out}`);

if (flag("--publish")) {
  console.log(`▶ GitHub 릴리스 ${tag} 만드는 중…`);
  execFileSync(
    "gh",
    [
      "release", "create", tag,
      join(out, assetName),
      join(out, "papago-tts-downloader.exe"),
      join(out, "latest.json"),
      "--repo", REPO,
      "--title", tag,
      ...(notesFile ? ["--notes-file", resolve(notesFile)] : ["--notes", notes || tag]),
    ],
    { cwd: root, stdio: "inherit" },
  );
  console.log(`✔ https://github.com/${REPO}/releases/tag/${tag}`);
}
