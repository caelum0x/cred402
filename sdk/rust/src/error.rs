//! Cred402 SDK error type.

use std::fmt;

#[derive(Debug)]
pub enum Cred402Error {
    /// The API returned a structured failure (`{success:false, error:{code,message}}`).
    Api { code: String, message: String },
    /// Network/transport failure reaching the node.
    Transport(String),
    /// Response body could not be decoded.
    Decode(String),
}

impl fmt::Display for Cred402Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Cred402Error::Api { code, message } => write!(f, "api error [{}]: {}", code, message),
            Cred402Error::Transport(m) => write!(f, "transport error: {}", m),
            Cred402Error::Decode(m) => write!(f, "decode error: {}", m),
        }
    }
}

impl std::error::Error for Cred402Error {}
