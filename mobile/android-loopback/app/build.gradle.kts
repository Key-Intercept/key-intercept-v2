plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val configuredLoopbackPort = (
    providers.gradleProperty("loopbackPort").orNull
        ?: providers.environmentVariable("KEY_INTERCEPT_LOOPBACK_PORT").orNull
        ?: "35491"
).toIntOrNull()
    ?.takeIf { it in 1..65535 }
    ?: 35491

val developerModeEnabled = (
    providers.gradleProperty("developerMode").orNull
        ?: providers.environmentVariable("KEY_INTERCEPT_DEVELOPER_MODE").orNull
        ?: providers.environmentVariable("KEY_INTERCEPT_DEBUG_MODE").orNull
        ?: "false"
).trim().lowercase().let { value ->
    value == "1" || value == "true" || value == "yes" || value == "on"
}

val configuredRelayPort = (
    providers.gradleProperty("relayPort").orNull
        ?: providers.environmentVariable("KEY_INTERCEPT_RELAY_PORT").orNull
        ?: if (developerModeEnabled) "46001" else "35491"
).toIntOrNull()
    ?.takeIf { it in 1..65535 }
    ?: if (developerModeEnabled) 46001 else 35491

android {
    namespace = "com.keyintercept.loopback"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.keyintercept.loopback"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("int", "LOOPBACK_PORT", configuredLoopbackPort.toString())
        buildConfigField("boolean", "DEVELOPER_MODE_ENABLED", developerModeEnabled.toString())
        buildConfigField("int", "RELAY_PORT", configuredRelayPort.toString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-service:2.8.6")
}
