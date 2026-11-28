import Foundation

enum JSON {
    /// Whether a value JSONSerialization decoded was `true` or `false`.
    static func isBool(_ value: Any) -> Bool {
        #if canImport(Darwin)
            guard let number = value as? NSNumber else { return false }
            return CFGetTypeID(number) == CFBooleanGetTypeID()
        #else
            // swift-corelibs-foundation decodes JSON booleans as Swift `Bool`,
            // which an `as? NSNumber` cast would otherwise turn into 1 or 0.
            return type(of: value) == Bool.self
        #endif
    }
}
