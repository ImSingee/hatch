//! The two things Tauri does not expose for WKWebView.
//!
//! 1. Which frame a navigation is for. Tauri's `on_navigation` sees only the
//!    URL, so it cannot keep the top-level page on the instance while letting
//!    an App's frames embed other sites. A proxy navigation delegate answers
//!    `decidePolicyForNavigationAction` with the frame in hand and forwards
//!    everything else to wry's own delegate, so page-load events, downloads
//!    and Tauri's `on_navigation` keep working.
//! 2. A form POST into the page, which the platform's browser handoff needs.
//! 3. Address changes that load no page. Single-page navigation (signing in
//!    on `/login` lands on the desk with a router push) changes the WKWebView's
//!    `URL` without a page-load event; key-value observing sees every change.

use block2::DynBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::NSColorSpace;
use objc2_foundation::{
    ns_string, NSData, NSDictionary, NSKeyValueChangeKey, NSKeyValueObservingOptions,
    NSMutableURLRequest, NSObjectNSKeyValueObserverRegistration, NSString, NSURL,
};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationType, WKWebView,
};
use std::ffi::c_void;

/// One navigation as WebKit asks about it.
pub struct Navigation {
    pub url: String,
    /// The window's own page, not a frame inside it.
    pub main_frame: bool,
    /// A request for a new window (`target=_blank`, `window.open`). WebKit
    /// asks Tauri's `on_new_window` next, which decides those.
    pub new_window: bool,
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
                    main_frame: action.targetFrame().is_some_and(|frame| frame.isMainFrame()),
                    new_window: action.targetFrame().is_none(),
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

pub struct UrlObserverIvars {
    on_change: Box<dyn Fn(String)>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HatchUrlObserver"]
    #[ivars = UrlObserverIvars]
    struct UrlObserver;

    unsafe impl NSObjectProtocol for UrlObserver {}

    impl UrlObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe(
            &self,
            _key_path: Option<&NSString>,
            object: Option<&AnyObject>,
            _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
            _context: *mut c_void,
        ) {
            let Some(object) = object else { return };
            let webview = unsafe { &*(object as *const AnyObject as *const WKWebView) };
            if let Some(url) = unsafe { webview.URL() }.and_then(|url| url.absoluteString()) {
                (self.ivars().on_change)(url.to_string());
            }
        }
    }
);

/// Calls `on_change` with the page's address whenever it changes, including
/// history pushes that load no page.
///
/// # Safety
/// As for `install_navigation_proxy`.
pub unsafe fn observe_url(webview: *mut c_void, on_change: Box<dyn Fn(String)>) {
    let webview = &*(webview as *const WKWebView);
    let mtm = MainThreadMarker::new().expect("WebKit runs on the main thread");
    let observer = UrlObserver::alloc(mtm).set_ivars(UrlObserverIvars { on_change });
    let observer: Retained<UrlObserver> = msg_send![super(observer), init];
    webview.addObserver_forKeyPath_options_context(
        &observer,
        ns_string!("URL"),
        NSKeyValueObservingOptions::New,
        std::ptr::null_mut(),
    );
    // Observed for the app's lifetime, like the window itself.
    std::mem::forget(observer);
}

/// An sRGB colour with components from 0 to 1.
pub type Rgb = (f64, f64, f64);

/// Called with the page's theme colour, or `None` when it declares none.
pub type OnThemeColor = Box<dyn Fn(Option<Rgb>)>;

pub struct ThemeColorObserverIvars {
    on_change: OnThemeColor,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HatchThemeColorObserver"]
    #[ivars = ThemeColorObserverIvars]
    struct ThemeColorObserver;

    unsafe impl NSObjectProtocol for ThemeColorObserver {}

    impl ThemeColorObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe(
            &self,
            _key_path: Option<&NSString>,
            object: Option<&AnyObject>,
            _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
            _context: *mut c_void,
        ) {
            let Some(object) = object else { return };
            let webview = unsafe { &*(object as *const AnyObject as *const WKWebView) };
            (self.ivars().on_change)(unsafe { theme_color(webview) });
        }
    }
);

/// The page's `theme-color` in sRGB, if it declares one.
unsafe fn theme_color(webview: &WKWebView) -> Option<Rgb> {
    let color = webview.themeColor()?;
    let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
    Some((
        srgb.redComponent(),
        srgb.greenComponent(),
        srgb.blueComponent(),
    ))
}

/// Calls `on_change` with the page's `<meta name="theme-color">` whenever
/// it changes, and once now.
///
/// # Safety
/// As for `install_navigation_proxy`.
pub unsafe fn observe_theme_color(webview: *mut c_void, on_change: OnThemeColor) {
    let webview = &*(webview as *const WKWebView);
    let mtm = MainThreadMarker::new().expect("WebKit runs on the main thread");
    on_change(theme_color(webview));
    let observer = ThemeColorObserver::alloc(mtm).set_ivars(ThemeColorObserverIvars { on_change });
    let observer: Retained<ThemeColorObserver> = msg_send![super(observer), init];
    webview.addObserver_forKeyPath_options_context(
        &observer,
        ns_string!("themeColor"),
        NSKeyValueObservingOptions::New,
        std::ptr::null_mut(),
    );
    // Observed for the app's lifetime, like the window itself.
    std::mem::forget(observer);
}
