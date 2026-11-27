//! Where a native App's view goes in the window, and pictures of it.
//!
//! The page reports each App surface's rectangle in CSS pixels with its
//! viewport width; the view goes to that rectangle in the window's content
//! view, above the WKWebView. AppKit keeps a view's margins to its
//! superview's edges while the window resizes (the container's autoresizing
//! mask), so a live resize moves it at once and the page's next report
//! corrects what the margins cannot express.

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_app_kit::{NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize};
use serde::Deserialize;

/// A rectangle in the page's CSS pixels.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where a CSS rectangle lies in the content view, in points.
///
/// `webview` is the web view's frame in the content view, `viewport_width`
/// the page's `innerWidth` (CSS pixels across the web view: page zoom
/// changes it), `flipped` whether the content view's origin is its top left.
pub fn to_content_frame(
    rect: CssRect,
    viewport_width: f64,
    webview: NSRect,
    flipped: bool,
) -> NSRect {
    let scale = if viewport_width > 0.0 {
        webview.size.width / viewport_width
    } else {
        1.0
    };
    let width = (rect.width * scale).max(0.0);
    let height = (rect.height * scale).max(0.0);
    let x = webview.origin.x + rect.x * scale;
    let y = if flipped {
        webview.origin.y + rect.y * scale
    } else {
        webview.origin.y + webview.size.height - rect.y * scale - height
    };
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

/// The window's web view: wry puts it in the content view.
fn webview_of(content: &NSView) -> Option<Retained<NSView>> {
    content
        .subviews()
        .iter()
        .find(|view| view.class().name().to_string_lossy().contains("WebView"))
}

/// Adds `container` above the web view, hidden until it is placed.
pub fn attach(window: &NSWindow, container: &NSView) -> bool {
    let Some(content) = window.contentView() else {
        return false;
    };
    container.setHidden(true);
    content.addSubview_positioned_relativeTo(container, NSWindowOrderingMode::Above, None);
    true
}

/// Moves `container` to the page's `rect` (CSS pixels, `viewport_width`
/// across the web view).
pub fn place(window: &NSWindow, container: &NSView, rect: CssRect, viewport_width: f64) {
    let Some(content) = window.contentView() else {
        return;
    };
    let Some(webview) = webview_of(&content) else {
        return;
    };
    let frame = to_content_frame(rect, viewport_width, webview.frame(), content.isFlipped());
    if container.frame() != frame {
        container.setFrame(frame);
    }
}

/// The view's pixels as PNG, drawn from its layers (Core Animation draws
/// NSH's views; `cacheDisplayInRect` would ask their `drawRect`, which
/// draws nothing).
pub fn snapshot_png(container: &NSView) -> Option<Vec<u8>> {
    use objc2_app_kit::{NSBitmapImageRep, NSGraphicsContext};
    {
        let layer = container.layer()?;
        let bounds = container.bounds();
        let scale = container
            .window()
            .map(|w| w.backingScaleFactor())
            .unwrap_or(2.0);
        let width = (bounds.size.width * scale).round() as isize;
        let height = (bounds.size.height * scale).round() as isize;
        if width <= 0 || height <= 0 {
            return None;
        }
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                width,
                height,
                8,
                4,
                true,
                false,
                objc2_app_kit::NSDeviceRGBColorSpace,
                0,
                0,
            )
        }?;
        rep.setSize(bounds.size);
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
        let cg = context.CGContext();
        objc2_core_graphics::CGContext::scale_ctm(Some(&cg), scale, scale);
        if container.isFlipped() || layer.isGeometryFlipped() {
            objc2_core_graphics::CGContext::translate_ctm(Some(&cg), 0.0, bounds.size.height);
            objc2_core_graphics::CGContext::scale_ctm(Some(&cg), 1.0, -1.0);
        }
        layer.renderInContext(&cg);
        context.flushGraphics();
        let data = unsafe {
            rep.representationUsingType_properties(
                objc2_app_kit::NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }?;
        Some(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }

    #[test]
    fn unflipped_content_view_measures_from_the_bottom() {
        let frame = to_content_frame(
            CssRect {
                x: 200.0,
                y: 50.0,
                width: 600.0,
                height: 400.0,
            },
            1000.0,
            rect(0.0, 0.0, 1000.0, 800.0),
            false,
        );
        assert_eq!(frame, rect(200.0, 350.0, 600.0, 400.0));
    }

    #[test]
    fn page_zoom_scales_css_pixels() {
        // Zoomed to 125%: 1000 points show 800 CSS pixels.
        let frame = to_content_frame(
            CssRect {
                x: 100.0,
                y: 40.0,
                width: 400.0,
                height: 200.0,
            },
            800.0,
            rect(0.0, 0.0, 1000.0, 800.0),
            true,
        );
        assert_eq!(frame, rect(125.0, 50.0, 500.0, 250.0));
    }
}
