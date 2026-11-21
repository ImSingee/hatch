//! Developer probes for the plan's open assumptions. Built into debug builds
//! and `--features probes`, never into a distributed build.
//!
//! - B1: an AppKit view can live in the Tauri window, over the page or beside
//!   it (where an NSH player would go). The probe adds a native panel with a
//!   native text field, so mouse and keyboard reach AppKit, not WebKit.
//! - B2: what WebAuthn reports inside this WKWebView.

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSTextField, NSUserInterfaceItemIdentification, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{ns_string, NSPoint, NSRect, NSSize};
use std::ffi::c_void;

const PANEL_ID: &str = "app.hatch.desktop.probe.native-panel";
const PANEL_WIDTH: f64 = 320.0;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Floats over the bottom-right of the page.
    Over,
    /// Takes the right edge; the page shrinks beside it.
    Beside,
}

fn find_panel(content: &NSView) -> Option<objc2::rc::Retained<NSView>> {
    content.subviews().iter().find(|view| {
        view.identifier()
            .is_some_and(|id| id.to_string() == PANEL_ID)
    })
}

/// Shows the native panel, or removes it when it is already shown.
/// Returns whether it is now shown.
///
/// # Safety
/// `ns_window` is the main window's NSWindow, on the main thread.
pub unsafe fn toggle_native_panel(ns_window: *mut c_void, placement: Placement) -> bool {
    let mtm = MainThreadMarker::new().expect("AppKit runs on the main thread");
    let window = &*(ns_window as *const NSWindow);
    let Some(content) = window.contentView() else {
        return false;
    };
    let bounds = content.bounds();
    // wry's content view holds one subview: the WKWebView.
    let webview = content
        .subviews()
        .iter()
        .find(|view| view.class().name().to_string_lossy().contains("WebView"));

    if let Some(panel) = find_panel(&content) {
        panel.removeFromSuperview();
        if let Some(webview) = webview {
            webview.setFrame(bounds);
        }
        return false;
    }

    let frame = match placement {
        Placement::Over => NSRect::new(
            NSPoint::new(bounds.size.width - PANEL_WIDTH - 24.0, 24.0),
            NSSize::new(PANEL_WIDTH, 168.0),
        ),
        Placement::Beside => NSRect::new(
            NSPoint::new(bounds.size.width - PANEL_WIDTH, 0.0),
            NSSize::new(PANEL_WIDTH, bounds.size.height),
        ),
    };
    let panel = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), frame);
    panel.setMaterial(NSVisualEffectMaterial::Sidebar);
    panel.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
    panel.setState(NSVisualEffectState::Active);
    panel.setIdentifier(Some(&objc2_foundation::NSString::from_str(PANEL_ID)));
    panel.setAutoresizingMask(match placement {
        Placement::Over => {
            NSAutoresizingMaskOptions::ViewMinXMargin | NSAutoresizingMaskOptions::ViewMaxYMargin
        }
        Placement::Beside => {
            NSAutoresizingMaskOptions::ViewMinXMargin | NSAutoresizingMaskOptions::ViewHeightSizable
        }
    });

    let top = frame.size.height - 52.0;
    let title = NSTextField::labelWithString(ns_string!("Native AppKit view (B1 probe)"), mtm);
    title.setFrame(NSRect::new(
        NSPoint::new(16.0, top),
        NSSize::new(PANEL_WIDTH - 32.0, 20.0),
    ));
    title.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    panel.addSubview(&title);

    let note = NSTextField::wrappingLabelWithString(
        ns_string!("This panel is an NSVisualEffectView in the Tauri window's content view, above the WKWebView. Type below: keys go to AppKit."),
        mtm,
    );
    note.setFrame(NSRect::new(
        NSPoint::new(16.0, top - 64.0),
        NSSize::new(PANEL_WIDTH - 32.0, 60.0),
    ));
    note.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    panel.addSubview(&note);

    let field = NSTextField::textFieldWithString(ns_string!(""), mtm);
    field.setPlaceholderString(Some(ns_string!("Native text field")));
    field.setFrame(NSRect::new(
        NSPoint::new(16.0, top - 100.0),
        NSSize::new(PANEL_WIDTH - 32.0, 24.0),
    ));
    field.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    panel.addSubview(&field);

    if placement == Placement::Beside {
        if let Some(webview) = webview {
            webview.setFrame(NSRect::new(
                bounds.origin,
                NSSize::new(bounds.size.width - PANEL_WIDTH, bounds.size.height),
            ));
        }
    }
    content.addSubview_positioned_relativeTo(&panel, NSWindowOrderingMode::Above, None);
    window.makeFirstResponder(Some(&field));
    true
}

/// Runs WebAuthn's own checks in the page and shows what it reports in a
/// banner at the top of the page.
pub const PASSKEY_PROBE_SCRIPT: &str = r#"(async () => {
  const lines = [];
  const show = () => {
    let box = document.getElementById('hatch-passkey-probe');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'hatch-passkey-probe';
      box.style.cssText = 'position:fixed;z-index:2147483647;top:60px;left:50%;transform:translateX(-50%);max-width:640px;margin:0;padding:12px 16px;border-radius:12px;background:#1E2230;color:#fff;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;box-shadow:0 10px 30px rgba(0,0,0,.25)';
      box.title = 'Click to dismiss';
      box.onclick = () => box.remove();
      document.body.append(box);
    }
    box.textContent = 'Passkey probe (B2) on ' + location.origin + '\n' + lines.join('\n');
  };
  lines.push('isSecureContext: ' + window.isSecureContext);
  lines.push('PublicKeyCredential: ' + typeof window.PublicKeyCredential);
  try {
    lines.push('platform authenticator: ' + await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (e) { lines.push('platform authenticator: ' + e); }
  show();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    lines.push('get(): waiting…'); show();
    await navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, timeout: 15000, userVerification: 'preferred' } });
    lines[lines.length - 1] = 'get(): resolved';
  } catch (e) { lines[lines.length - 1] = 'get(): ' + e.name + ': ' + e.message; }
  show();
  try {
    lines.push('create(): waiting…'); show();
    await navigator.credentials.create({ publicKey: {
      challenge, rp: { id: location.hostname, name: 'Hatch probe' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'probe@example.com', displayName: 'Probe' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 15000,
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } } });
    lines[lines.length - 1] = 'create(): resolved (credential not sent anywhere)';
  } catch (e) { lines[lines.length - 1] = 'create(): ' + e.name + ': ' + e.message; }
  show();
})();"#;
