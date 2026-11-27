//! 자막 파일 (SRT, LRC) 만들기

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
    Srt,
    Lrc,
}

impl Format {
    pub fn parse(s: Option<&str>) -> Result<Option<Format>, String> {
        match s {
            None | Some("") | Some("none") => Ok(None),
            Some("srt") => Ok(Some(Format::Srt)),
            Some("lrc") => Ok(Some(Format::Lrc)),
            Some(other) => Err(format!("지원하지 않는 자막 형식입니다: {other}")),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Format::Srt => "srt",
            Format::Lrc => "lrc",
        }
    }

    pub fn render(self, cues: &[Cue]) -> String {
        match self {
            Format::Srt => to_srt(cues),
            Format::Lrc => to_lrc(cues),
        }
    }
}

fn srt_time(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

fn lrc_time(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as u64;
    format!("[{:02}:{:02}.{:02}]", cs / 6000, cs / 100 % 60, cs % 100)
}

pub fn to_srt(cues: &[Cue]) -> String {
    let mut out = String::new();
    for (i, c) in cues.iter().enumerate() {
        out.push_str(&format!(
            "{}\r\n{} --> {}\r\n{}\r\n\r\n",
            i + 1,
            srt_time(c.start),
            srt_time(c.end),
            c.text
        ));
    }
    out
}

pub fn to_lrc(cues: &[Cue]) -> String {
    let mut out = String::from("[re:Papago TTS Downloader]\r\n");
    for c in cues {
        out.push_str(&format!("{}{}\r\n", lrc_time(c.start), c.text));
    }
    // 마지막 문장이 끝나면 가사를 지운다
    if let Some(last) = cues.last() {
        out.push_str(&format!("{}\r\n", lrc_time(last.end)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cues() -> Vec<Cue> {
        vec![
            Cue { start: 0.0, end: 1.234, text: "안녕하세요.".into() },
            Cue { start: 1.234, end: 3725.5, text: "반갑습니다!".into() },
        ]
    }

    #[test]
    fn srt_format() {
        assert_eq!(
            to_srt(&cues()),
            "1\r\n00:00:00,000 --> 00:00:01,234\r\n안녕하세요.\r\n\r\n\
             2\r\n00:00:01,234 --> 01:02:05,500\r\n반갑습니다!\r\n\r\n"
        );
    }

    #[test]
    fn lrc_format() {
        assert_eq!(
            to_lrc(&cues()),
            "[re:Papago TTS Downloader]\r\n[00:00.00]안녕하세요.\r\n[00:01.23]반갑습니다!\r\n[62:05.50]\r\n"
        );
    }

    #[test]
    fn parses_format_option() {
        assert_eq!(Format::parse(None), Ok(None));
        assert_eq!(Format::parse(Some("none")), Ok(None));
        assert_eq!(Format::parse(Some("srt")), Ok(Some(Format::Srt)));
        assert_eq!(Format::parse(Some("lrc")), Ok(Some(Format::Lrc)));
        assert!(Format::parse(Some("vtt")).is_err());
    }
}
