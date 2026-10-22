cmake_minimum_required(VERSION 3.16)
file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" NIUMA_VERSION LIMIT_COUNT 1)
project(NiuMaMerit VERSION "${NIUMA_VERSION}" LANGUAGES C CXX)

enable_testing()
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
  target_link_libraries(niuma-merit PRIVATE shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
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
  target_link_libraries(niuma-woodfish-render-test PRIVATE shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
  if(MSVC)
    set_property(TARGET niuma-woodfish-render-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-woodfish-render-test PRIVATE /W4 /permissive- /utf-8 /UNDEBUG)
  endif()
  foreach(phase IN ITEMS before after)
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
    target_link_libraries(niuma-render-profile-${phase} PRIVATE shell32 gdiplus ole32 bcrypt comdlg32 comctl32 uxtheme)
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
