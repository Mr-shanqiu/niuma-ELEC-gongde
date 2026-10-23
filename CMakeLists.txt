cmake_minimum_required(VERSION 3.16)
file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" NIUMA_VERSION LIMIT_COUNT 1)
project(NiuMaMerit VERSION "${NIUMA_VERSION}" LANGUAGES C CXX)

enable_testing()
find_package(Threads REQUIRED)
add_library(niuma-input-core STATIC src/client/core/input_state.cpp)
target_compile_features(niuma-input-core PUBLIC cxx_std_17)
add_executable(niuma-client-input-test scripts/test-client-input-state.cpp)
target_link_libraries(niuma-client-input-test PRIVATE niuma-input-core Threads::Threads)
add_test(NAME niuma-client-input COMMAND niuma-client-input-test)
add_executable(niuma-client-ledger-test scripts/test-client-ledger-snapshot.cpp)
target_link_libraries(niuma-client-ledger-test PRIVATE niuma-input-core Threads::Threads)
add_test(NAME niuma-client-ledger COMMAND niuma-client-ledger-test)
add_library(niuma-runtime-core STATIC src/client/core/animation_player.cpp src/client/core/storage_state.cpp)
target_link_libraries(niuma-runtime-core PUBLIC niuma-input-core)
target_compile_features(niuma-runtime-core PUBLIC cxx_std_17)
add_executable(niuma-animation-player-test scripts/test-client-animation-player.cpp)
target_link_libraries(niuma-animation-player-test PRIVATE niuma-runtime-core)
add_test(NAME niuma-animation-player COMMAND niuma-animation-player-test)
set_tests_properties(niuma-animation-player PROPERTIES WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
add_executable(niuma-storage-state-test scripts/test-client-storage-state.cpp)
target_link_libraries(niuma-storage-state-test PRIVATE niuma-runtime-core)
add_test(NAME niuma-storage-state COMMAND niuma-storage-state-test)
add_library(niuma-alpha-region STATIC src/windows/runtime/alpha_region.cpp
  src/windows/runtime/prepared_alpha_region.cpp)
target_compile_features(niuma-alpha-region PUBLIC cxx_std_17)
if(WIN32)
  target_link_libraries(niuma-alpha-region PUBLIC gdi32)
endif()
add_executable(niuma-alpha-region-test scripts/test-windows-alpha-region.cpp)
target_link_libraries(niuma-alpha-region-test PRIVATE niuma-alpha-region)
add_test(NAME niuma-alpha-region COMMAND niuma-alpha-region-test)
add_executable(niuma-prepared-alpha-test scripts/test-windows-prepared-alpha-region.cpp)
target_link_libraries(niuma-prepared-alpha-test PRIVATE niuma-alpha-region)
add_test(NAME niuma-prepared-alpha COMMAND niuma-prepared-alpha-test)
if(MSVC)
  foreach(runtime_target niuma-input-core niuma-client-input-test niuma-client-ledger-test niuma-runtime-core niuma-animation-player-test niuma-storage-state-test niuma-alpha-region niuma-alpha-region-test niuma-prepared-alpha-test)
    target_compile_options(${runtime_target} PRIVATE /W4 /permissive- /utf-8)
    target_compile_definitions(${runtime_target} PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
    set_property(TARGET ${runtime_target} PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  endforeach()
endif()
add_executable(niuma-reminder-activity-test src/reminder_activity_test.cpp)
target_compile_features(niuma-reminder-activity-test PRIVATE cxx_std_17)
if(MSVC)
  target_compile_options(niuma-reminder-activity-test PRIVATE /W4 /permissive- /utf-8)
  add_executable(niuma-presign-boundary-test
    scripts/test-windows-presign-boundaries.cpp
    src/windows/appearance_pack.cpp
    third_party/miniz/miniz.c)
  target_include_directories(niuma-presign-boundary-test PRIVATE src/windows third_party/miniz "${CMAKE_CURRENT_BINARY_DIR}")
  target_compile_features(niuma-presign-boundary-test PRIVATE cxx_std_17)
  target_compile_definitions(niuma-presign-boundary-test PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS)
  target_link_libraries(niuma-presign-boundary-test PRIVATE shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
  if(MSVC)
    set_property(TARGET niuma-presign-boundary-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-presign-boundary-test PRIVATE /W4 /permissive- /utf-8 /UNDEBUG)
  endif()
elseif(APPLE)
  target_compile_options(niuma-reminder-activity-test PRIVATE -Wall -Wextra)
endif()
if(WIN32)
  add_library(niuma-windows-input STATIC src/windows/runtime/input_service.cpp)
  target_link_libraries(niuma-windows-input PUBLIC niuma-input-core Threads::Threads user32)
  if(TARGET niuma-presign-boundary-test)
    target_link_libraries(niuma-presign-boundary-test PRIVATE niuma-windows-input niuma-windows-storage)
  endif()
  target_compile_definitions(niuma-windows-input PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
  add_library(niuma-windows-storage STATIC src/windows/runtime/storage_service.cpp)
  target_link_libraries(niuma-windows-storage PUBLIC niuma-runtime-core Threads::Threads user32)
  target_compile_definitions(niuma-windows-storage PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
  add_executable(niuma-storage-service-test scripts/test-windows-storage-service.cpp)
  target_link_libraries(niuma-storage-service-test PRIVATE niuma-windows-storage)
  target_compile_definitions(niuma-storage-service-test PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
  add_executable(niuma-input-service-probe
    scripts/probe-windows-input-service.cpp
    src/windows/runtime/input_service.cpp)
  target_link_libraries(niuma-input-service-probe PRIVATE niuma-input-core Threads::Threads user32)
  target_compile_definitions(niuma-input-service-probe PRIVATE
    NIUMA_INPUT_SERVICE_DIAGNOSTICS UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
  add_executable(niuma-input-contract-test
    scripts/test-windows-input-service-contract.cpp
    src/windows/runtime/input_service.cpp)
  target_link_libraries(niuma-input-contract-test PRIVATE niuma-input-core Threads::Threads user32)
  target_compile_definitions(niuma-input-contract-test PRIVATE
    NIUMA_INPUT_SERVICE_DIAGNOSTICS UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
  if(MSVC)
    foreach(input_target niuma-windows-input niuma-input-service-probe niuma-input-contract-test niuma-windows-storage niuma-storage-service-test)
      target_compile_options(${input_target} PRIVATE /W4 /permissive- /utf-8)
      set_property(TARGET ${input_target} PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    endforeach()
  endif()
  add_executable(niuma-runtime-p0
    scripts/probe-windows-runtime.cpp
    scripts/runtime-p0-fixtures.cpp
    src/windows/runtime/d3d11_renderer.cpp)
  target_compile_features(niuma-runtime-p0 PRIVATE cxx_std_17)
  target_compile_definitions(niuma-runtime-p0 PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(niuma-runtime-p0 PRIVATE niuma-alpha-region d3d11 dxgi dcomp d3dcompiler windowscodecs ole32 user32 gdi32 psapi)
  if(MSVC)
    target_compile_options(niuma-runtime-p0 PRIVATE /W4 /permissive- /utf-8)
    set_property(TARGET niuma-runtime-p0 PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  endif()
  add_executable(niuma-render-cache-test scripts/test-windows-render-cache.cpp)
  target_compile_features(niuma-render-cache-test PRIVATE cxx_std_17)
  target_compile_definitions(niuma-render-cache-test PRIVATE UNICODE _UNICODE NOMINMAX)
  target_link_libraries(niuma-render-cache-test PRIVATE gdiplus user32 gdi32)
  if(MSVC)
    target_compile_options(niuma-render-cache-test PRIVATE /W4 /permissive- /utf-8)
    set_property(TARGET niuma-render-cache-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  endif()
  target_link_libraries(niuma-reminder-activity-test PRIVATE bcrypt)
elseif(APPLE)
  target_link_libraries(niuma-reminder-activity-test PRIVATE
    "-framework Security" "-framework CoreFoundation")
endif()
add_test(NAME niuma-reminder-activity COMMAND niuma-reminder-activity-test)
set_tests_properties(niuma-reminder-activity PROPERTIES
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
)

if(WIN32)
  configure_file(src/windows/app.rc "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc" @ONLY)
  configure_file(src/app_version.h.in "${CMAKE_CURRENT_BINARY_DIR}/app_version.h" @ONLY)
  configure_file(src/windows/app.manifest "${CMAKE_CURRENT_BINARY_DIR}/app.manifest" COPYONLY)
  configure_file(assets/woodfish.png "${CMAKE_CURRENT_BINARY_DIR}/woodfish.png" COPYONLY)
  configure_file(assets/mallet.png "${CMAKE_CURRENT_BINARY_DIR}/mallet.png" COPYONLY)
  configure_file(assets/developer-douyin.png "${CMAKE_CURRENT_BINARY_DIR}/developer-douyin.png" COPYONLY)
  configure_file(assets/appicon.ico "${CMAKE_CURRENT_BINARY_DIR}/appicon.ico" COPYONLY)
  add_executable(niuma-merit WIN32
    src/windows/app.cpp
    src/windows/appearance_pack.cpp
    third_party/miniz/miniz.c
    "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc"
  )
  target_include_directories(niuma-merit PRIVATE src/windows third_party/miniz "${CMAKE_CURRENT_BINARY_DIR}")
  set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc" PROPERTIES GENERATED TRUE)
  # The real window procedure uses comctl32 v6 ordinal imports. Match the
  # production activation context instead of loading the legacy system DLL.
  if(TARGET niuma-presign-boundary-test)
    target_sources(niuma-presign-boundary-test PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc")
    target_link_options(niuma-presign-boundary-test PRIVATE /MANIFEST:NO)
  endif()
  target_compile_features(niuma-merit PRIVATE cxx_std_17)
  target_compile_definitions(niuma-merit PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS)
  target_link_libraries(niuma-merit PRIVATE niuma-windows-input niuma-windows-storage shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
  add_executable(niuma-runtime-app-test
    scripts/test-windows-runtime-app.cpp
    src/windows/runtime/input_service.cpp
    src/windows/appearance_pack.cpp
    third_party/miniz/miniz.c
    "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc")
  target_include_directories(niuma-runtime-app-test PRIVATE src/windows third_party/miniz "${CMAKE_CURRENT_BINARY_DIR}")
  target_compile_features(niuma-runtime-app-test PRIVATE cxx_std_17)
  target_compile_definitions(niuma-runtime-app-test PRIVATE NIUMA_INPUT_SERVICE_DIAGNOSTICS UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS)
  target_link_libraries(niuma-runtime-app-test PRIVATE niuma-input-core niuma-windows-storage Threads::Threads user32 shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
  if(MSVC)
    set_property(TARGET niuma-runtime-app-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-runtime-app-test PRIVATE /W4 /permissive- /utf-8 /UNDEBUG)
    target_link_options(niuma-runtime-app-test PRIVATE /MANIFEST:NO)
  endif()
  if(MSVC)
    set_property(TARGET niuma-merit PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-merit PRIVATE /W4 /permissive- /utf-8)
    # app.rc embeds our explicit DPI/compatibility manifest. Disable the
    # linker's generated default manifest to avoid a duplicate resource.
    target_link_options(niuma-merit PRIVATE /MANIFEST:NO)
  endif()

  add_executable(niuma-pack-test
    src/windows/appearance_pack_test.cpp
    src/windows/appearance_pack.cpp
    third_party/miniz/miniz.c
  )
  target_include_directories(niuma-pack-test PRIVATE src/windows third_party/miniz)
  target_compile_features(niuma-pack-test PRIVATE cxx_std_17)
  target_compile_definitions(niuma-pack-test PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS NIUMA_BATCH_DIAGNOSTICS)
  target_link_libraries(niuma-pack-test PRIVATE gdiplus ole32 shell32 bcrypt)
  if(MSVC)
    set_property(TARGET niuma-pack-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-pack-test PRIVATE /W4 /permissive- /utf-8)
  endif()

  add_executable(niuma-woodfish-render-test
    scripts/test-windows-woodfish-render.cpp
    src/windows/appearance_pack.cpp
    third_party/miniz/miniz.c
  )
  target_include_directories(niuma-woodfish-render-test PRIVATE src/windows third_party/miniz "${CMAKE_CURRENT_BINARY_DIR}")
  target_compile_features(niuma-woodfish-render-test PRIVATE cxx_std_17)
  target_compile_definitions(niuma-woodfish-render-test PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS)
  target_link_libraries(niuma-woodfish-render-test PRIVATE niuma-windows-input niuma-windows-storage shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
  if(MSVC)
    set_property(TARGET niuma-woodfish-render-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-woodfish-render-test PRIVATE /W4 /permissive- /utf-8 /UNDEBUG)
  endif()
  foreach(phase IN ITEMS before previous after)
    add_executable(niuma-render-profile-${phase}
      scripts/profile-windows-render-path.cpp
      third_party/miniz/miniz.c
      "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc")
    target_include_directories(niuma-render-profile-${phase} PRIVATE src/windows third_party/miniz "${CMAKE_CURRENT_BINARY_DIR}")
    target_compile_features(niuma-render-profile-${phase} PRIVATE cxx_std_17)
    target_compile_definitions(niuma-render-profile-${phase} PRIVATE
      UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS
      NIUMA_PROFILE_APP_SOURCE="${CMAKE_CURRENT_BINARY_DIR}/profile-app-${phase}.cpp"
      NIUMA_PROFILE_PACK_SOURCE="${CMAKE_CURRENT_BINARY_DIR}/profile-pack-${phase}.cpp"
      NIUMA_PROFILE_VERSION="${phase}")
    if(phase STREQUAL "after")
      target_compile_definitions(niuma-render-profile-${phase} PRIVATE NIUMA_PROFILE_AFTER)
    elseif(phase STREQUAL "previous")
      target_compile_definitions(niuma-render-profile-${phase} PRIVATE NIUMA_PROFILE_PREVIOUS)
    endif()
    target_link_libraries(niuma-render-profile-${phase} PRIVATE niuma-windows-input niuma-windows-storage psapi shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
    if(MSVC)
      set_property(TARGET niuma-render-profile-${phase} PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
      target_compile_options(niuma-render-profile-${phase} PRIVATE /W4 /permissive- /utf-8)
      target_link_options(niuma-render-profile-${phase} PRIVATE /MANIFEST:NO)
    endif()
  endforeach()
elseif(APPLE)
  enable_language(OBJCXX)
  set(MACOS_RESOURCES
    assets/appicon.icns
    assets/woodfish.png
    assets/mallet.png
    assets/developer-douyin.png
  )
  set_source_files_properties(${MACOS_RESOURCES} PROPERTIES
    MACOSX_PACKAGE_LOCATION "Resources"
  )
  set(MACOS_LOCALIZATIONS
    src/macos/en.lproj/InfoPlist.strings
    src/macos/zh-Hans.lproj/InfoPlist.strings
    src/macos/zh-Hant.lproj/InfoPlist.strings
  )
  set_source_files_properties(src/macos/en.lproj/InfoPlist.strings PROPERTIES
    MACOSX_PACKAGE_LOCATION "Resources/en.lproj")
  set_source_files_properties(src/macos/zh-Hans.lproj/InfoPlist.strings PROPERTIES
    MACOSX_PACKAGE_LOCATION "Resources/zh-Hans.lproj")
  set_source_files_properties(src/macos/zh-Hant.lproj/InfoPlist.strings PROPERTIES
    MACOSX_PACKAGE_LOCATION "Resources/zh-Hant.lproj")
  add_executable(niuma-merit MACOSX_BUNDLE
    src/macos/app.mm
    ${MACOS_RESOURCES}
    ${MACOS_LOCALIZATIONS}
  )
  target_compile_features(niuma-merit PRIVATE cxx_std_17)
  target_compile_options(niuma-merit PRIVATE -Wall -Wextra -fobjc-arc)
  target_link_libraries(niuma-merit PRIVATE
    "-framework AppKit"
    "-framework ApplicationServices"
    "-framework ServiceManagement"
    "-framework Security"
  )
  set_target_properties(niuma-merit PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "NiuMa Merit"
    MACOSX_BUNDLE_GUI_IDENTIFIER "cn.niuma.merit"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/src/macos/Info.plist.in"
    MACOSX_DEPLOYMENT_TARGET "10.15"
    XCODE_ATTRIBUTE_ENABLE_HARDENED_RUNTIME "YES"
  )
  add_executable(niuma-login-startup-test scripts/test-macos-login-startup.mm)
  target_compile_features(niuma-login-startup-test PRIVATE cxx_std_17)
  target_compile_options(niuma-login-startup-test PRIVATE -Wall -Wextra -fobjc-arc -mmacosx-version-min=10.15)
  target_link_libraries(niuma-login-startup-test PRIVATE
    "-framework AppKit" "-framework ApplicationServices" "-framework Security"
    "-framework ServiceManagement")
  add_test(NAME niuma-login-startup COMMAND niuma-login-startup-test)
else()
  message(FATAL_ERROR "This product supports Windows and macOS only")
endif()
