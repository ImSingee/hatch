//! The window follows the instance theme's appearance.
//!
//! While the instance theme has a fixed mode, the web UI publishes the ground
//! it draws as `<meta name="theme-color">` (see
//! `src/ui/theme/theme-store.ts`); WebKit reports it as the web view's
//! `themeColor`. A dark ground makes the window dark (title bar, traffic
//! lights, menus and the colour shown before a page paints), a light one
//! light. Without a theme colour (the `system` mode, and the bundled
//! first-run page) the window follows the device. Forcing it there would
//! also pin the page's `prefers-color-scheme`, so a page following the
//! device could never change again.

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

/// The window appearance for the page's theme colour; `None` follows the
/// device.
pub fn theme_for(color: Option<Rgb>) -> Option<Theme> {
    // Darker than mid grey: text on it is light, so the window is dark.
    color.map(|rgb| {
        if luminance(rgb) < 0.18 {
            Theme::Dark
        } else {
            Theme::Light
        }
    })
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
        assert_eq!(theme_for(Some(dark)), Some(Theme::Dark));
        assert_eq!(background_for(Some(dark), GROUND), Color(23, 25, 31, 255));
    }

    #[test]
    fn light_grounds_stay_light_and_pages_without_one_follow_the_device() {
        // desk's ground, #EDEBE6, and a custom light ground.
        assert_eq!(
            theme_for(Some((237.0 / 255.0, 235.0 / 255.0, 230.0 / 255.0))),
            Some(Theme::Light)
        );
        assert_eq!(
            theme_for(Some((243.0 / 255.0, 246.0 / 255.0, 239.0 / 255.0))),
            Some(Theme::Light)
        );
        assert_eq!(theme_for(None), None);
        assert_eq!(background_for(None, GROUND), GROUND);
    }
}
