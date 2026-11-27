//! mp3 조각을 이어 붙이고 길이를 계산하는 데 필요한 최소한의 처리.
//!
//! 파파고 TTS mp3 구조: [ID3v2 태그][Info 프레임][소리 프레임…][Info 프레임][소리 프레임…]…
//! (파파고가 문장별 mp3를 이어 붙여 보내서 문장마다 Info 프레임이 있다)
//! 조각을 이어 붙일 때 두 번째 조각부터의 ID3 태그와 각 조각 맨 앞의 Info 프레임을 빼야
//! 플레이어가 전체 길이를 잘못 표시하지 않는다.

/// 맨 앞의 ID3v2 태그 길이 (없으면 0).
pub fn id3v2_len(b: &[u8]) -> usize {
    if b.len() >= 10 && &b[0..3] == b"ID3" {
        let size = ((b[6] as usize & 0x7f) << 21)
            | ((b[7] as usize & 0x7f) << 14)
            | ((b[8] as usize & 0x7f) << 7)
            | (b[9] as usize & 0x7f);
        let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
        let end = 10 + size + footer;
        if end <= b.len() {
            return end;
        }
    }
    0
}

/// 맨 뒤의 ID3v1 태그를 떼어 낸다.
pub fn strip_id3v1(b: &[u8]) -> &[u8] {
    let n = b.len();
    if n >= 128 && &b[n - 128..n - 125] == b"TAG" {
        &b[..n - 128]
    } else {
        b
    }
}

/// MPEG 오디오 프레임 머리 정보
struct Frame {
    len: usize,
    samples: u32,
    sample_rate: u32,
    /// Xing/Info 태그가 들어 있는 위치 (프레임 시작 기준)
    tag_offset: usize,
}

fn parse_header(b: &[u8]) -> Option<Frame> {
    if b.len() < 4 {
        return None;
    }
    let h = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    if h >> 21 != 0x7ff {
        return None;
    }
    let version = (h >> 19) & 3; // 0: MPEG-2.5, 2: MPEG-2, 3: MPEG-1
    let layer = (h >> 17) & 3; // 1: Layer III, 2: Layer II, 3: Layer I
    let bitrate_idx = ((h >> 12) & 0xf) as usize;
    let rate_idx = ((h >> 10) & 3) as usize;
    let padding = (h >> 9) & 1;
    let mono = (h >> 6) & 3 == 3;
    if version == 1 || layer == 0 || bitrate_idx == 0 || bitrate_idx == 15 || rate_idx == 3 {
        return None;
    }
    let mpeg1 = version == 3;
    let sample_rate = match version {
        3 => [44100, 48000, 32000][rate_idx],
        2 => [22050, 24000, 16000][rate_idx],
        _ => [11025, 12000, 8000][rate_idx],
    };
    let kbps: u32 = match (mpeg1, layer) {
        (true, 3) => [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448][bitrate_idx],
        (true, 2) => [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384][bitrate_idx],
        (true, _) => [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrate_idx],
        (false, 3) => [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256][bitrate_idx],
        (false, _) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][bitrate_idx],
    };
    let samples = match (layer, mpeg1) {
        (3, _) => 384,
        (2, _) => 1152,
        (_, true) => 1152,
        (_, false) => 576,
    };
    let len = if layer == 3 {
        ((12 * kbps * 1000 / sample_rate + padding) * 4) as usize
    } else {
        (samples / 8 * kbps * 1000 / sample_rate + padding) as usize
    };
    // Layer III의 side info 길이 (Xing/Info 태그는 그 바로 뒤에 온다)
    let side_info = match (mpeg1, mono) {
        (true, false) => 32,
        (true, true) => 17,
        (false, false) => 17,
        (false, true) => 9,
    };
    if len < 4 {
        return None;
    }
    Some(Frame { len, samples, sample_rate, tag_offset: 4 + side_info })
}

fn is_info_frame(b: &[u8], f: &Frame) -> bool {
    let end = (f.tag_offset + 4).min(b.len());
    let tag = &b[f.tag_offset.min(end)..end];
    tag == b"Xing" || tag == b"Info"
}

/// 맨 앞의 Xing/Info 프레임(소리 없는 정보 프레임)을 떼어 낸다.
pub fn strip_info_frame(b: &[u8]) -> &[u8] {
    match parse_header(b) {
        Some(f) if f.len <= b.len() && is_info_frame(&b[..f.len], &f) => &b[f.len..],
        _ => b,
    }
}

/// 재생 길이(초)를 구한다. 플레이어와 같은 기준으로 센다:
/// 맨 앞의 Info 프레임만 건너뛰고, 중간에 낀 Info 프레임은 무음 프레임으로 재생되므로 센다.
/// (파파고는 문장별 mp3를 이어 붙여 보내서 한 응답 안에도 문장마다 Info 프레임이 있다.)
pub fn duration_secs(data: &[u8]) -> f64 {
    let mut b = &data[id3v2_len(data)..];
    b = strip_id3v1(b);
    let mut i = 0;
    let mut secs = 0.0;
    let mut first = true;
    while i + 4 <= b.len() {
        match parse_header(&b[i..]) {
            Some(f) => {
                let end = (i + f.len).min(b.len());
                if !(first && is_info_frame(&b[i..end], &f)) {
                    secs += f.samples as f64 / f.sample_rate as f64;
                }
                first = false;
                i += f.len;
            }
            None => i += 1,
        }
    }
    secs
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// MPEG-2 Layer III, 64kbps, 24kHz, 모노 프레임 (파파고와 같은 형식, 192바이트)
    pub fn frame(info: bool) -> Vec<u8> {
        let mut f = vec![0u8; 192];
        f[..4].copy_from_slice(&[0xff, 0xf3, 0x84, 0xc4]);
        if info {
            f[13..17].copy_from_slice(b"Info");
        }
        f
    }

    pub fn clip(frames: usize) -> Vec<u8> {
        let mut v = b"ID3\x03\x00\x00\x00\x00\x00\x02xx".to_vec();
        v.extend(frame(true));
        for _ in 0..frames {
            v.extend(frame(false));
        }
        v
    }

    #[test]
    fn counts_only_audio_frames() {
        // 소리 프레임 29개 = 29 × 576 / 24000 = 0.696초 (실제 파파고 파일과 같은 값)
        let d = duration_secs(&clip(29));
        assert!((d - 0.696).abs() < 1e-9, "{d}");
    }

    #[test]
    fn strips_tags_and_info_frame() {
        let c = clip(3);
        let body = &c[id3v2_len(&c)..];
        assert_eq!(body.len(), 192 * 4);
        let audio = strip_info_frame(body);
        assert_eq!(audio.len(), 192 * 3);
        assert_eq!(strip_info_frame(audio).len(), audio.len()); // 소리 프레임은 그대로

        let mut v1 = b"AUDIO".to_vec();
        v1.extend_from_slice(b"TAG");
        v1.extend(std::iter::repeat(0u8).take(125));
        assert_eq!(strip_id3v1(&v1), b"AUDIO");
    }

    #[test]
    fn counts_info_frames_in_the_middle() {
        // 문장 두 개를 이어 붙인 파파고 응답처럼: [Info][소리×2][Info][소리×2]
        let mut v = frame(true);
        v.extend(frame(false));
        v.extend(frame(false));
        v.extend(frame(true));
        v.extend(frame(false));
        v.extend(frame(false));
        // 맨 앞 Info만 빼고 5프레임 = 0.120초
        assert!((duration_secs(&v) - 0.120).abs() < 1e-9);
        // 맨 앞 Info를 떼어 내면 6프레임 중 Info가 중간에만 있으므로 5프레임 그대로
        assert!((duration_secs(strip_info_frame(&v)) - 0.120).abs() < 1e-9);
    }

    #[test]
    fn skips_garbage_between_frames() {
        let mut v = frame(false);
        v.extend_from_slice(&[1, 2, 3]);
        v.extend(frame(false));
        assert!((duration_secs(&v) - 0.048).abs() < 1e-9);
    }
}
