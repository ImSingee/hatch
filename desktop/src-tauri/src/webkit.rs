//! The two things Tauri does not expose for WKWebView.
//!
//! 1. Which frame a navigation is for. Tauri's `on_navigation` sees only the
//!    URL, so it cannot keep the top-level page on the instance while letting
//!    an App's frames embed other sites. A proxy navigation delegate answers
//!    `decidePolicyForNavigationAction` with the frame in hand and forwards
//!    everything else to wry's own delegate, so page-load events, downloads
//!    and Tauri's `on_navigation` keep working.
//! 2. A form POST into the page, which the platform's browser handoff needs.

use block2::DynBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_foundation::{ns_string, NSData, NSMutableURLRequest, NSString, NSURL};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationType, WKWebView,
};
use std::ffi::c_void;

/// One navigation as WebKit asks about it.
pub struct Navigation {
    pub url: String,
    /// The window's own page, not a frame inside it.
    pub main_frame: bool,
    /// The person clicked a link or submitted a form (not a script).
    pub user_initiated: bool,
    /// The address the window currently shows.
    pub current_url: Option<String>,
}

/// Returns whether WebKit may go ahead. Side effects (opening a link in the
/// browser) happen inside.
pub type Decide = Box<dyn Fn(&Navigation) -> bool>;

pub struct ProxyIvars {
    inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
    decide: Decide,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HatchNavigationProxy"]
    #[ivars = ProxyIvars]
    struct NavigationProxy;

    impl NavigationProxy {
        /// Everything this class does not answer goes to wry's delegate.
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().inner) as *mut AnyObject
        }

        #[unsafe(method(respondsToSelector:))]
        fn responds(&self, selector: Sel) -> bool {
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            own || self.ivars().inner.respondsToSelector(selector)
        }
    }

    unsafe impl NSObjectProtocol for NavigationProxy {}

    unsafe impl WKNavigationDelegate for NavigationProxy {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let navigation = unsafe {
                Navigation {
                    url: action
                        .request()
                        .URL()
                        .and_then(|url| url.absoluteString())
                        .map(|url| url.to_string())
                        .unwrap_or_default(),
                    // No target frame means a new window; Tauri's
                    // `on_new_window` decides those.
                    main_frame: action.targetFrame().is_none_or(|frame| frame.isMainFrame()),
                    user_initiated: matches!(
                        action.navigationType(),
                        WKNavigationType::LinkActivated | WKNavigationType::FormSubmitted
                    ),
                    current_url: webview
                        .URL()
                        .and_then(|url| url.absoluteString())
                        .map(|url| url.to_string()),
                }
            };
            if (self.ivars().decide)(&navigation) {
                unsafe {
                    self.ivars()
                        .inner
                        .webView_decidePolicyForNavigationAction_decisionHandler(webview, action, handler)
                };
            } else {
                handler.call((WKNavigationActionPolicy::Cancel,));
            }
        }
    }
);

impl NavigationProxy {
    fn new(
        mtm: MainThreadMarker,
        inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
        decide: Decide,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ProxyIvars { inner, decide });
        unsafe { msg_send![super(this), init] }
    }
}

/// Puts the proxy in front of wry's navigation delegate.
///
/// # Safety
/// `webview` is the window's live WKWebView (`PlatformWebview::inner`), and
/// this runs on the main thread.
pub unsafe fn install_navigation_proxy(webview: *mut c_void, decide: Decide) {
    let webview = &*(webview as *const WKWebView);
    let mtm = MainThreadMarker::new().expect("WebKit runs on the main thread");
    let Some(inner) = webview.navigationDelegate() else {
        panic!("wry installs a navigation delegate before the page loads");
    };
    let proxy = NavigationProxy::new(mtm, inner, decide);
    webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*proxy)));
    // WKWebView holds its delegate weakly. The window lives as long as the
    // app, so the proxy does too.
    std::mem::forget(proxy);
}

/// Loads `url` in the page as a top-level form POST of `body`
/// (`application/x-www-form-urlencoded`), naming `origin` as the requester.
///
/// # Safety
/// As for `install_navigation_proxy`.
pub unsafe fn load_form_post(webview: *mut c_void, url: &str, body: &str, origin: &str) {
    let webview = &*(webview as *const WKWebView);
    let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
        return;
    };
    let request = NSMutableURLRequest::requestWithURL(&url);
    request.setHTTPMethod(ns_string!("POST"));
    request.setValue_forHTTPHeaderField(
        Some(ns_string!("application/x-www-form-urlencoded")),
        ns_string!("Content-Type"),
    );
    // WebKit sends no Origin for an app-initiated load; the handoff accepts
    // only its own origin when one is present, so name it.
    request.setValue_forHTTPHeaderField(Some(&NSString::from_str(origin)), ns_string!("Origin"));
    request.setHTTPBody(Some(&NSData::with_bytes(body.as_bytes())));
    webview.loadRequest(&request);
}
