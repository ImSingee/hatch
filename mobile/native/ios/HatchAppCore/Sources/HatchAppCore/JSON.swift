import Foundation

enum JSON {
    /// Whether a number JSONSerialization decoded was `true` or `false`.
    static func isBool(_ number: NSNumber) -> Bool {
        #if canImport(Darwin)
            return CFGetTypeID(number) == CFBooleanGetTypeID()
        #else
            // swift-corelibs-foundation decodes JSON booleans as Swift `Bool`,
            // which never arrives here as an NSNumber.
            return false
        #endif
    }
}
