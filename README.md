# Key-Intercept-V2

Welcome to Key-Intercept V2, a new plugin for discord that helps you talk ~un~properly.

Basically, this is a lil program that sits in the back of your discord. When you send a message, it will edit it in some way.

> Note: This plugin makes use of Vencord which is an unsupported use of Discord. To use it is a breach of TOS. As a result, you are using it (and this plugin) at your own risk.

## Contents
 - [Changes From Version 1](#changes-from-v1)
 - [Install](#install)
 - [Usage](#usage)
 - [Bugs & Issues](#bugs)
 - [Distributing](#distribution)
 - [Support Development](#support)

## Changes from V1
 - Configs are stored in a local .json file rather than in a database.
 - All config controls are now within the Discord UI (rather than relying on an external website or bot).
 - A separate loopback server is used on PC (this enables discord's sandboxed env to save to the disk).
 - Uses a relay server to transmit between clients, which can be setup and configured to allow for your own private uses of KI.
 - Executable install file (rather than terminal script).
 - Different instances of a user account (e.g. Windows and Android) now have separate configs.
 - You are now required to have KI installed to edit other ppls KI configs.
 - Makes use of rust for various servers.

 > If you are coming from Key Intercept V1, you can use the ladel bot to type `/export` to get the json file, this can then be placed into a new file at `C:/Users/<your user>/AppData/Roaming/key-intercept/config.json` on windows or `~/.config/key-intercept/config.json` on linux (you'll have to recreate it manually on Mobile).

## Install

This program supports [Windows](#windows), [Linux](#linux), [Android](#android) mobile and [IOS](#ios) mobile.

For mac users, the [Linux](#linux) install might work, but I have no way of testing this and thus will not be maintaining this.

### Windows
To install on Windows:

1. Go to [Releases](https://github.com/Key-intercept/key-intercept-v2/releases/latest)
2. Click `key-intercept-installer-windows-x86_64.zip` to download the installer.
3. Unzip the downloaded file.
4. Run the .exe file.
5. Enter your discord user ID when requested.
6. When the terminal appears to be waiting, press enter.
7. Start Discord.
8. Go to Discord settings -> plugins and enable key-intercept.

### Linux
To install on Linux:

1. Go to [Releases](https://github.com/Key-Intercept/key-intercept-v2/releases/latest)
2. Click `key-intercept-installer-linux-x86_64.tar.gz` to download the installer.
3. Extract the installer by running
```sh
tar -xf <file location>
```
4. Run the file with the command line arg `--user-discord-id` followed by your Discord user-discord-id
5. When the terminal appears to be waiting, press enter.
6. Start Discord.
7. Go to Discord settings -> plugins and enable key-intercept.

### Android
To install on Android:

1. Download the [APK](https://github.com/C0C0B01/KettuManager/releases/latest) for Kettu.
2. Run it to install Kettu.
3. Open Kettu.
4. Go to Profile > Settings > Plugins.
5. Click the plus button in the bottom right hand corner.
6. Type in the source [https://key-intercept.github.io/key-intercept-v2/](https://key-intercept.github.io/key-intercept-v2/).
7. Click install.
8. Make sure the plugin is enabled.

### IOS
To install on IOS:

> Note: I have no apple devices and refuse to get any, so I have no way of testing this.
> Also note: you will need a pc to install this unless you know how to sideload without PC

1. Download iloader on PC
2. Connect your phone to PC via USB
3. Sign in to your IOS account on Iloader
4. Set the server to "stikstore"
5. On the IPhone, go to settings > general > vpn & device management
6. You should see a new developer app, enable it
7. Go to settings > privacy & security and enable developer mode
8. Restart your phone
9. kettu should now be installed
10. Open Kettu.
11. Go to Profile > Settings > Plugins.
12. Click the plus button in the bottom right hand corner.
13. Type in the source [https://key-intercept.github.io/key-intercept-v2/](https://key-intercept.github.io/key-intercept-v2/).
14. Click install.
15. Make sure the plugin is enabled.

## Usage

Each user has a 'config' which allows controlling how they speak. On PC, you can access this by clicking on your profile, to access someone elses config, they must first give permission (see [Allowing Editors](#allowing-editors)). Other user's config's can be found by clicking on their profile.

On Mobile, your own config, as well as the configs of others can be found in the plugin settings (click the wrench icon). Enter the Discord ID of the user you would like to edit.

### Allowing Editors

To allow someone else to edit your config, you first must make sure you are on the same server (you would know if you werent). Then simply enter their Discord ID into the "Allowed Editors" section.

### Modes

Key Intercept comes pre-installed with a variety of custom modes which are easily controlled and setup. Each of these can be set on a timer to end after a sepcific amount of time has elapsed. These can be enabled individually or multiple at once.

The pre-installed modes are:

 - [Gag](#gag-mode)
 - [Pet](#pet-mode)
 - [Bimbo](#bimbo-mode)
 - [Horny](#horny-mode)
 - [Drone](#drone-mode)
 - [UWU](#uwu-mode)
 - [Censored](#censored-mode)

#### Gag
This mode simulates the user having a gag in their mouth. Replacing text with something mostly illegible

#### Pet
This mode allows a random chance for words to be replaced with pet noises.

There are 7 pet types:

- Puppy
- Kitty
- Cow
- Fox
- Bird
- Bee
- Bunny

You can set a percentage chance for each pet mode.

#### Bimbo
This mode has 3 features:

1. Every now and then, a random "like" will be inserted between words
2. Every pronoun (1st or 3rd person) will be followed with the phrase "like totally"
3. A maximum word length can be set. If this word count is gone over, the rest of the message will be replaced with "uhh long words harddd hehe"


#### Honry
Gives a horny percentage, higher percentage means higher chance that random "horny word" with be inserted between your normal words

#### Drone
This mode has 2 features

1. Adds a header and footer to each message, these are by default "This Drone Says:" and "It Obeys.". They can be changed to whatever you like. This will also adapt to your message as to whether you are writing an *action*, **shouting** or -# whispering
2. Adds a "damage" modifier in which the drone can be damaged causing it to glitch with random "beep" and "bzzt" noises, as well as beginning to slur words, if the drones health becomes lower than 10 (starts at 100) it will "bluescreen".

#### UWU
Makes the user talk through UWU.

#### Censored
Censores certain words by replacing them with a "replacement" word.

### Custom Rules
Rules allow you to create your own custom modes by creating rule groups, each containing a series of rules.

A rule has 2 main components:
 - A rule written in [RegEx](https://regexr.com/) (a language used to identify patterns in text)
 - A replacement which is what will be placed for every match of the regex rule

There are other components to a rule such as the chance for it to activate, but I will leave you to discover these in your own time.

Rule groups can also be set to disable after a period of time, the same as the pre-build modes.

### Whitelist
The whitelist allows you to specify which servers you want the plugin to run on. It will only run on the selected servers / DM's.

You can add a server / dm by right clicking on it and clicking "Add to whitelist: `server_name`".

The whitelist can also be changed to be a blacklist, this will cause the plugin to run on any server except the specified ones.

## Bugs

If you experience any bugs or issues, please check the [Issues](https://github.com/Key-Intercept/key-intercept-v2/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug) page. If you can see your issue there then it is something that is actively being fixed, otherwise, create an issue describing your problem.

## Support

This system takes a lot of effort to create, manage and maintain. So I appreciate any support you can give.

Please note, supporting development entitles you to **nothing**, it is of the kindness of your heart if you help out.

### Financially

<a href="https://www.buymeacoffee.com/supersliser" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: 41px !important;width: 174px !important;box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;-webkit-box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;" ></a>

### Write some code

To add to this repo, make a pull request with the code for your requested change. I will review it and merge it if it works properly.
