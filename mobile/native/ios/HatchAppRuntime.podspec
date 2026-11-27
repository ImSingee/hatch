# Hatch's native App runtime as one pod for the Expo app: the core and the
# runtime (the two Swift packages beside this file) and the NSH SDK the
# config plugin fetched into vendor/ (scripts/fetch-nsh-sdk.mjs). Only this
# pod links NativeShell.xcframework, a static framework.
Pod::Spec.new do |s|
  s.name             = 'HatchAppRuntime'
  s.version          = '0.1.0'
  s.summary          = 'Runs Hatch native Apps: one NSH engine per App, verified packages, the host bridge.'
  s.license          = 'UNLICENSED'
  s.author           = 'Hatch'
  s.homepage         = 'https://github.com/singee/hatch'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { git: '' }
  s.static_framework = true
  s.source_files     = 'HatchAppCore/Sources/HatchAppCore/**/*.swift', 'HatchAppRuntime/Sources/HatchAppRuntime/**/*.swift'
  s.vendored_frameworks = 'vendor/NativeShell.xcframework'
  # NSH 0.7.0's static framework does not auto-link Network.
  s.frameworks       = 'Network', 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
