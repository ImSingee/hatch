#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// The division reserved regions of `view` (where a foldable display folds),
/// active or not, as frames in the view's own coordinates. Empty when the SDK
/// or the system has no reserved regions, which means there is no fold.
FOUNDATION_EXPORT NSArray<NSValue *> *HatchFoldDivisionFrames(UIView *view);

/// The edge where the system places the vertical bar for `view`: 1 leading,
/// 2 trailing, 0 where no vertical bar is used or the SDK has none.
FOUNDATION_EXPORT NSInteger HatchVerticalBarEdge(UIView *view);

/// Calls `handler` when the traits that decide the vertical bar's edge change.
/// Does nothing on SDKs and systems without a vertical bar.
FOUNDATION_EXPORT void HatchObserveVerticalBarEdge(UIView *view,
                                                   void (^handler)(void));

NS_ASSUME_NONNULL_END
