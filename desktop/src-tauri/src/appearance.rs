//! The window follows the signed-in user's theme's appearance.
//!
//! The web UI publishes the ground of the active theme as
//! `<meta name="theme-color">` (see `src/ui/theme/theme-store.ts`); WebKit
//! reports it as the web view's `themeColor`. A dark ground makes the window
//! dark (title bar, traffic lights, menus and the colour shown before a page
//! paints), a light one light, whatever macOS is set to. The bundled
//! first-run page has no theme colour and draws the built-in light tokens,
//! so the window is light there.

use crate::webkit::Rgb;
use tauri::{window::Color, Theme};

fn channel(value: f64) -> f64 {
    if value <= 0.03928 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

/// WCAG relative luminance.
fn luminance((r, g, b): Rgb) -> f64 {
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// The window appearance for the page's theme colour.
pub fn theme_for(color: Option<Rgb>) -> Theme {
    match color {
        // Darker than mid grey: text on it is light, so the window is dark.
        Some(rgb) if luminance(rgb) < 0.18 => Theme::Dark,
        _ => Theme::Light,
    }
}

/// The window background matching the page, for the frames before it paints.
pub fn background_for(color: Option<Rgb>, fallback: Color) -> Color {
    match color {
        Some((r, g, b)) => {
            let byte = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
            Color(byte(r), byte(g), byte(b), 0xFF)
        }
        None => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROUND: Color = Color(0xED, 0xEB, 0xE6, 0xFF);

    #[test]
    fn dark_grounds_make_the_window_dark() {
        // desk-dark's ground, #17191F.
        let dark = (23.0 / 255.0, 25.0 / 255.0, 31.0 / 255.0);
        assert_eq!(theme_for(Some(dark)), Theme::Dark);
        assert_eq!(background_for(Some(dark), GROUND), Color(23, 25, 31, 255));
    }

    #[test]
    fn light_grounds_and_pages_without_a_theme_are_light() {
        // desk's ground, #EDEBE6, and a custom light ground.
        assert_eq!(
            theme_for(Some((237.0 / 255.0, 235.0 / 255.0, 230.0 / 255.0))),
            Theme::Light
        );
        assert_eq!(
            theme_for(Some((243.0 / 255.0, 246.0 / 255.0, 239.0 / 255.0))),
            Theme::Light
        );
        assert_eq!(theme_for(None), Theme::Light);
        assert_eq!(background_for(None, GROUND), GROUND);
    }
}
