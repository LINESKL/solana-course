//! SOL <-> lamports и форматирование времени — без float и без внешних крейтов.

use crate::error::{Error, Result};

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// "1.5" -> 1_500_000_000. Строковый разбор, чтобы не терять точность на f64.
pub fn parse_sol(s: &str) -> Result<u64> {
    let bad = || Error::InvalidAmount(s.to_string());
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if frac.len() > 9 || (whole.is_empty() && frac.is_empty()) || !digits(whole) || !digits(frac) {
        return Err(bad());
    }
    let whole: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| bad())?
    };
    let frac: u64 = format!("{frac:0<9}").parse().map_err(|_| bad())?;
    whole
        .checked_mul(LAMPORTS_PER_SOL)
        .and_then(|l| l.checked_add(frac))
        .ok_or_else(bad)
}

/// 1_500_000_000 -> "1.5", 5_000 -> "0.000005".
pub fn fmt_sol(lamports: u64) -> String {
    fmt_lamports(u128::from(lamports))
}

/// Изменение баланса со знаком: "+2", "-2.000079934", "0".
pub fn fmt_sol_delta(delta: i128) -> String {
    let sign = match delta.signum() {
        1 => "+",
        -1 => "-",
        _ => "",
    };
    format!("{sign}{}", fmt_lamports(delta.unsigned_abs()))
}

fn fmt_lamports(lamports: u128) -> String {
    let per_sol = u128::from(LAMPORTS_PER_SOL);
    let s = format!("{}.{:09}", lamports / per_sol, lamports % per_sol);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Unix time -> "2026-09-26 09:46:13 UTC".
pub fn fmt_unix_time(ts: i64) -> String {
    let (days, secs) = (ts.div_euclid(86_400), ts.rem_euclid(86_400));
    // алгоритм civil_from_days (H. Hinnant): дни от 1970-01-01 -> дата григорианского календаря
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        secs / 3_600,
        secs % 3_600 / 60,
        secs % 60
    )
}

/// "2ag4fKAcRh6x...WgCoG" -> "2ag4…gCoG" для узких таблиц.
pub fn short(addr: &str) -> String {
    if addr.len() <= 12 {
        return addr.to_string();
    }
    format!("{}…{}", &addr[..4], &addr[addr.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sol_without_float() {
        assert_eq!(parse_sol("1").unwrap(), LAMPORTS_PER_SOL);
        assert_eq!(parse_sol("1.5").unwrap(), 1_500_000_000);
        assert_eq!(parse_sol(".000000001").unwrap(), 1);
        assert_eq!(parse_sol("0.1").unwrap(), 100_000_000);
    }

    #[test]
    fn rejects_bad_amounts() {
        for bad in ["", ".", "-1", "1e3", "abc", "0.0000000001", "99999999999"] {
            assert!(parse_sol(bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn formats_sol_trimming_zeros() {
        assert_eq!(fmt_sol(2 * LAMPORTS_PER_SOL), "2");
        assert_eq!(fmt_sol(1_500_000_000), "1.5");
        assert_eq!(fmt_sol(5_000), "0.000005");
        assert_eq!(fmt_sol(0), "0");
    }

    #[test]
    fn formats_signed_deltas() {
        assert_eq!(fmt_sol_delta(2_000_000_000), "+2");
        assert_eq!(fmt_sol_delta(-2_000_079_934), "-2.000079934");
        assert_eq!(fmt_sol_delta(0), "0");
    }

    #[test]
    fn formats_unix_time_in_utc() {
        assert_eq!(fmt_unix_time(1_790_415_973), "2026-09-26 09:46:13 UTC");
        assert_eq!(fmt_unix_time(0), "1970-01-01 00:00:00 UTC");
    }

    #[test]
    fn shortens_addresses() {
        assert_eq!(
            short("2ag4fKAcRh6xBdtA3YojgdRoBJ4jRYxQSezDECQWgCoG"),
            "2ag4…gCoG"
        );
        assert_eq!(short("abc"), "abc");
    }
}
