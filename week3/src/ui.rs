//! Цвета в терминале. Автоматически отключаются, если вывод не в терминал
//! (pipe, файл) или задана переменная окружения NO_COLOR.

use owo_colors::{OwoColorize, Stream::Stdout};
use std::fmt::Display;

pub fn bold(s: impl Display) -> String {
    s.if_supports_color(Stdout, |t| t.bold()).to_string()
}

pub fn dim(s: impl Display) -> String {
    s.if_supports_color(Stdout, |t| t.dimmed()).to_string()
}

pub fn green(s: impl Display) -> String {
    s.if_supports_color(Stdout, |t| t.green()).to_string()
}

pub fn red(s: impl Display) -> String {
    s.if_supports_color(Stdout, |t| t.red()).to_string()
}

pub fn cyan(s: impl Display) -> String {
    s.if_supports_color(Stdout, |t| t.cyan()).to_string()
}

/// Строка «ключ: значение» с выровненной колонкой ключей.
pub fn kv(key: &str, value: impl Display) -> String {
    format!("{} {value}\n", dim(format!("{key:<12}")))
}

/// Таблица в едином стиле для всех команд.
pub fn table(header: &[&str]) -> comfy_table::Table {
    let mut t = comfy_table::Table::new();
    t.load_style(comfy_table::presets::UTF8_FULL_CONDENSED)
        .set_content_arrangement(comfy_table::ContentArrangement::Dynamic)
        .set_header(
            header
                .iter()
                .map(|h| comfy_table::Cell::new(h).add_attribute(comfy_table::Attribute::Bold)),
        );
    t
}
