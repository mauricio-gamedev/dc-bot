plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.astromg01.miovoice"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.astromg01.miovoice"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.1.4"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("com.cloudflare.realtimekit.android-vad:webrtc:2.0.10-cf.4")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.24.2")
}
