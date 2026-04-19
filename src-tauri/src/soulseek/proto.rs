//! SLSK binary protocol codec.
//!
//! All integers are little-endian. Strings are `[u32 len][bytes]`.
//! Every message is framed as `[u32 payload_len][payload]` where payload starts with a u32 code.

use tokio::io::AsyncReadExt;
use tokio::net::tcp::OwnedReadHalf;

/// Read one SLSK-framed message. Returns the raw payload bytes (code + data, without length prefix).
pub async fn recv_msg(r: &mut OwnedReadHalf) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 8 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("slsk msg too large: {len}B"),
        ));
    }
    let mut buf = vec![0u8; len];
    if len > 0 {
        r.read_exact(&mut buf).await?;
    }
    Ok(buf)
}

// ── Message builder ───────────────────────────────────────────────────────────

pub struct Msg(Vec<u8>);

impl Msg {
    pub fn new(code: u32) -> Self {
        let mut v = vec![0u8; 4]; // length placeholder
        v.extend_from_slice(&code.to_le_bytes());
        Msg(v)
    }

    pub fn u8(mut self, v: u8) -> Self {
        self.0.push(v);
        self
    }
    pub fn bool(self, v: bool) -> Self {
        self.u8(v as u8)
    }
    pub fn u32(mut self, v: u32) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u64(mut self, v: u64) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn str(mut self, s: &str) -> Self {
        let b = s.as_bytes();
        self.0.extend_from_slice(&(b.len() as u32).to_le_bytes());
        self.0.extend_from_slice(b);
        self
    }

    /// Finalise: write the 4-byte length prefix and return the frame bytes.
    pub fn build(mut self) -> Vec<u8> {
        let len = (self.0.len() - 4) as u32;
        self.0[..4].copy_from_slice(&len.to_le_bytes());
        self.0
    }
}

// ── Message reader ────────────────────────────────────────────────────────────

pub struct Buf<'a> {
    d: &'a [u8],
    pub pos: usize,
}

impl<'a> Buf<'a> {
    pub fn new(d: &'a [u8]) -> Self {
        Self { d, pos: 0 }
    }
    pub fn remaining(&self) -> usize {
        self.d.len().saturating_sub(self.pos)
    }

    pub fn u8(&mut self) -> Option<u8> {
        (self.pos < self.d.len()).then(|| {
            let v = self.d[self.pos];
            self.pos += 1;
            v
        })
    }
    pub fn bool(&mut self) -> Option<bool> {
        self.u8().map(|v| v != 0)
    }
    pub fn u32(&mut self) -> Option<u32> {
        if self.pos + 4 <= self.d.len() {
            let v = u32::from_le_bytes(self.d[self.pos..self.pos + 4].try_into().unwrap());
            self.pos += 4;
            Some(v)
        } else {
            None
        }
    }
    pub fn u64(&mut self) -> Option<u64> {
        if self.pos + 8 <= self.d.len() {
            let v = u64::from_le_bytes(self.d[self.pos..self.pos + 8].try_into().unwrap());
            self.pos += 8;
            Some(v)
        } else {
            None
        }
    }
    pub fn str(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        if self.pos + len <= self.d.len() {
            let s = String::from_utf8_lossy(&self.d[self.pos..self.pos + len]).into_owned();
            self.pos += len;
            Some(s)
        } else {
            None
        }
    }
    pub fn rest(&self) -> &[u8] {
        &self.d[self.pos..]
    }
}
