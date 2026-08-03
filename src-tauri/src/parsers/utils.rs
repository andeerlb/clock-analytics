/// Parses a "HH:MM" token into minutes since midnight.
pub fn hhmm_to_minutes(s: &str) -> Option<i32> {
    let (h, m) = s.split_once(':')?;
    let h: i32 = h.parse().ok()?;
    let m: i32 = m.parse().ok()?;
    Some(h * 60 + m)
}
