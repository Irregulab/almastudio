Pod::Spec.new do |s|
  s.name           = 'BackgroundWork'
  s.version        = '1.0.0'
  s.summary        = 'Background time for answering a notification action'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Irregulab'
  s.homepage       = 'https://almaware.net'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
