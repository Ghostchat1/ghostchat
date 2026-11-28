plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.ghostchat.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.raazdar"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "62").toInt() + 100
        versionName = "6.9"
    }

    // Sign with your own key if provided (needed so future updates install over this one).
    // Without it, the release APK is signed with a throwaway debug key: fine for testing.
    val ks = System.getenv("GC_KEYSTORE")
    signingConfigs {
        if (ks != null) create("own") {
            storeFile = file(ks)
            storePassword = System.getenv("GC_KEYSTORE_PASS")
            keyAlias = System.getenv("GC_KEY_ALIAS")
            keyPassword = System.getenv("GC_KEY_PASS")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = false
            signingConfig = signingConfigs.getByName(if (ks != null) "own" else "debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false; checkReleaseBuilds = false }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}

// Bundle the web app INSIDE the APK, so the app's code is never downloaded from the server.
val copyWeb by tasks.registering(Copy::class) {
    from(rootProject.file("../public"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
    exclude("sw.js")
}
tasks.named("preBuild") { dependsOn(copyWeb) }
