cmake_minimum_required(VERSION 3.16)
file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" NIUMA_VERSION LIMIT_COUNT 1)
project(NiuMaMerit VERSION "${NIUMA_VERSION}" LANGUAGES C CXX)

if(WIN32)
  configure_file(src/windows/app.rc "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc" COPYONLY)
  configure_file(src/windows/app.manifest "${CMAKE_CURRENT_BINARY_DIR}/app.manifest" COPYONLY)
  configure_file(assets/woodfish.png "${CMAKE_CURRENT_BINARY_DIR}/woodfish.png" COPYONLY)
  configure_file(assets/mallet.png "${CMAKE_CURRENT_BINARY_DIR}/mallet.png" COPYONLY)
  configure_file(assets/scenes/lucky-cat/lucky-cat-base.png "${CMAKE_CURRENT_BINARY_DIR}/lucky-cat-base.png" COPYONLY)
  configure_file(assets/scenes/lucky-cat/lucky-cat-actor.png "${CMAKE_CURRENT_BINARY_DIR}/lucky-cat-actor.png" COPYONLY)
  configure_file(assets/scenes/chick-pecking/chick-pecking-base.png "${CMAKE_CURRENT_BINARY_DIR}/chick-pecking-base.png" COPYONLY)
  configure_file(assets/scenes/chick-pecking/chick-pecking-actor.png "${CMAKE_CURRENT_BINARY_DIR}/chick-pecking-actor.png" COPYONLY)
  configure_file(assets/scenes/hamster-wheel/windows/hamster-habitat.png "${CMAKE_CURRENT_BINARY_DIR}/hamster-habitat.png" COPYONLY)
  configure_file(assets/scenes/hamster-wheel/windows/hamster-pet.png "${CMAKE_CURRENT_BINARY_DIR}/hamster-pet.png" COPYONLY)
  configure_file(assets/appicon.ico "${CMAKE_CURRENT_BINARY_DIR}/appicon.ico" COPYONLY)
  add_executable(niuma-merit WIN32
    src/windows/app.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc"
  )
  set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/niuma-app.rc" PROPERTIES GENERATED TRUE)
  target_compile_features(niuma-merit PRIVATE cxx_std_17)
  target_compile_definitions(niuma-merit PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(niuma-merit PRIVATE shell32 gdiplus ole32)
  if(MSVC)
    set_property(TARGET niuma-merit PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_options(niuma-merit PRIVATE /W4 /permissive- /utf-8)
    # app.rc embeds our explicit DPI/compatibility manifest. Disable the
    # linker's generated default manifest to avoid a duplicate resource.
    target_link_options(niuma-merit PRIVATE /MANIFEST:NO)
  endif()
elseif(APPLE)
  enable_language(OBJCXX)
  set(MACOS_RESOURCES
    assets/woodfish.png
    assets/mallet.png
    assets/scenes/lucky-cat/lucky-cat-base.png
    assets/scenes/lucky-cat/lucky-cat-actor.png
    assets/scenes/chick-pecking/chick-pecking-base.png
    assets/scenes/chick-pecking/chick-pecking-actor.png
    assets/scenes/hamster-wheel/runtime/hamster-habitat.png
    assets/scenes/hamster-wheel/runtime/hamster-pet.png
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
  )
  set_target_properties(niuma-merit PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "NiuMa Merit"
    MACOSX_BUNDLE_GUI_IDENTIFIER "cn.niuma.merit"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/src/macos/Info.plist.in"
    MACOSX_DEPLOYMENT_TARGET "10.15"
    XCODE_ATTRIBUTE_ENABLE_HARDENED_RUNTIME "YES"
  )
else()
  message(FATAL_ERROR "This product supports Windows and macOS only")
endif()
