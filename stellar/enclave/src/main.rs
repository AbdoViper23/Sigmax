//! `sigmax-enclave`: HTTP front end of the enclave service.
//!
//! ```text
//! sigmax-enclave            serve on ENCLAVE_BIND (default 127.0.0.1:8787)
//! sigmax-enclave keys       print the public keys as JSON and exit
//! ```
//!
//! Configuration (environment):
//! - `ENCLAVE_KEY_FILE`            key file, created on first start (default `.enclave/keys.json`)
//! - `STELLAR_NETWORK_PASSPHRASE`  defaults to the Testnet passphrase
//! - `ENCLAVE_SLIPPAGE_BPS`        min_out below the pool estimate (default 50)
//! - `ENCLAVE_MAX_POOL_SHARE_BPS`  per-signal cap on a pool's input reserve (default 200)
//! - `ENCLAVE_MIN_TRADE_USD`       smallest trade, USD with 7 decimals (default 10000000 = $1)
//!
//! Logs carry trade results only (vault, pair, amounts). Never the signal.

use std::{env, io::Read, path::PathBuf, process::ExitCode};

use sigmax_enclave::{
    api::{ApiError, Enclave},
    keys::EnclaveKeys,
    sizing::SizingConfig,
};
use tiny_http::{Header, Method, Response, Server};

const TESTNET: &str = "Test SDF Network ; September 2015";
const MAX_BODY: u64 = 256 * 1024;

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn json_response(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").expect("static header"))
}

fn error_body(e: &ApiError) -> String {
    serde_json::json!({ "error": e.message }).to_string()
}

fn handle(enclave: &Enclave, method: &Method, path: &str, body: &str) -> (u16, String) {
    let parse_err = |e: serde_json::Error| ApiError {
        status: 400,
        message: format!("bad request body: {e}"),
    };
    let result: Result<String, ApiError> = match (method, path) {
        (Method::Get, "/health") => Ok(serde_json::json!({
            "ok": true,
            "mode": "software",
            "held_signals": enclave.held_signals(),
        })
        .to_string()),
        (Method::Get, "/keys") => Ok(serde_json::to_string(&enclave.keys()).expect("serializable")),
        (Method::Post, "/signals") => serde_json::from_str(body)
            .map_err(parse_err)
            .and_then(|req| enclave.submit_signal(req))
            .map(|r| serde_json::to_string(&r).expect("serializable")),
        (Method::Post, "/authorize") => serde_json::from_str(body)
            .map_err(parse_err)
            .and_then(|req| enclave.authorize(req))
            .map(|r| {
                if let sigmax_enclave::api::AuthorizeResponse::Signed { plan, .. } = &r {
                    eprintln!(
                        "authorized pool={} in={} amount_in={} min_out={}",
                        plan.pool, plan.token_in, plan.amount_in, plan.min_out
                    );
                }
                serde_json::to_string(&r).expect("serializable")
            }),
        _ => Err(ApiError {
            status: 404,
            message: "not found".into(),
        }),
    };
    match result {
        Ok(body) => (200, body),
        Err(e) => (e.status, error_body(&e)),
    }
}

fn main() -> ExitCode {
    let key_file =
        PathBuf::from(env::var("ENCLAVE_KEY_FILE").unwrap_or_else(|_| ".enclave/keys.json".into()));
    let (keys, created) = match EnclaveKeys::load_or_create(&key_file) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("cannot load enclave keys from {}: {e}", key_file.display());
            return ExitCode::FAILURE;
        }
    };
    let passphrase = env::var("STELLAR_NETWORK_PASSPHRASE").unwrap_or_else(|_| TESTNET.into());
    let sizing = SizingConfig {
        slippage_bps: env_or("ENCLAVE_SLIPPAGE_BPS", 50),
        max_pool_share_bps: env_or("ENCLAVE_MAX_POOL_SHARE_BPS", 200),
        min_trade_usd: env_or("ENCLAVE_MIN_TRADE_USD", 10_000_000),
    };
    let enclave = Enclave::new(keys, &passphrase, sizing);

    if env::args().nth(1).as_deref() == Some("keys") {
        println!(
            "{}",
            serde_json::to_string_pretty(&enclave.keys()).expect("serializable")
        );
        return ExitCode::SUCCESS;
    }

    let bind = env::var("ENCLAVE_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let server = match Server::http(&bind) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot bind {bind}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let k = enclave.keys();
    eprintln!(
        "sigmax-enclave (software mode, Testnet only) on {bind}; keys {} ({}); signing key {}",
        key_file.display(),
        if created { "created" } else { "loaded" },
        k.signing_key_strkey
    );

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let path = request.url().split('?').next().unwrap_or("").to_string();
        let mut body = String::new();
        let read = request.as_reader().take(MAX_BODY).read_to_string(&mut body);
        let (status, out) = match read {
            Ok(_) => handle(&enclave, &method, &path, &body),
            Err(_) => (
                400,
                serde_json::json!({ "error": "body is not UTF-8" }).to_string(),
            ),
        };
        if status >= 400 {
            eprintln!("{method} {path} -> {status}");
        }
        let _ = request.respond(json_response(status, out));
    }
    ExitCode::SUCCESS
}
