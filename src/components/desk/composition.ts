/**
 * Whether a key press belongs to an input method's composition, such as the
 * Escape that cancels Pinyin being typed. WebKit (Safari, the macOS app)
 * sends the key that ends or cancels a composition with `isComposing` false
 * and `keyCode` 229, so `isComposing` alone misses it.
 */
export function isCompositionKey(
  event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>,
) {
  return event.isComposing || event.keyCode === 229;
}
