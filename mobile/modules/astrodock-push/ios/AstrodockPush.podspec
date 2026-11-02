Pod::Spec.new do |s|
  s.name           = 'AstrodockPush'
  s.version        = '1.0.0'
  s.summary        = 'Per-server Curve25519 push keys in the shared Keychain group.'
  s.description    = 'Creates, returns and deletes the X25519 key pair each Astrodock server encrypts notifications to.'
  s.author         = 'Astrodock'
  s.homepage       = 'https://astrodock.ai'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
