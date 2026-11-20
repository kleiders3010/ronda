// Ronda on Android: a Trusted Web Activity, i.e. the web app (quiz.jurisgames.com) opened full screen
// in the phone's own Chrome. The game runs in Chrome; this app holds no code of its own.
plugins {
    id("com.android.application")
}

android {
    namespace = "com.jurisgames.ronda"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.jurisgames.ronda"
        minSdk = 24
        targetSdk = 36
        versionCode = 2
        versionName = "1.0.1"
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
