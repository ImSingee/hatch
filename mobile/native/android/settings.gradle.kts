// Hatch's native App runtime on Android, built on its own for its tests
// (`core`: JVM unit tests; `runtime`: engine tests on a device). The Expo
// app includes the same two projects (see mobile/plugins).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.library") version "9.2.1"
        id("org.jetbrains.kotlin.android") version "2.2.10"
        id("org.jetbrains.kotlin.jvm") version "2.2.10"
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // NSH's nsh.aar (scripts/fetch-nsh-sdk.mjs).
        maven { url = uri("vendor/maven") }
    }
}

rootProject.name = "hatch-app-native"
include(":hatch-app-core")
project(":hatch-app-core").projectDir = file("core")
include(":hatch-app-runtime")
project(":hatch-app-runtime").projectDir = file("runtime")
