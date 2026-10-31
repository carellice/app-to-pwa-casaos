# Studying the native app

Goal: every value the PWA uses comes from the native source, not from a screenshot. Read the code
first, then use screenshots to check. Write the findings in `PWA/PORTING.md`.

## Where things live

| What | Android (Compose) | Android (Views/XML) | iOS (SwiftUI/UIKit) | Flutter | React Native |
|---|---|---|---|---|---|
| Screens, routes | `NavHost`/`composable("route")`, `*Screen.kt` | `nav_graph.xml`, Activities/Fragments | `NavigationStack`, `.sheet`, `UIViewController`s | `MaterialApp.routes`, `GoRouter` | `react-navigation` stacks/tabs |
| Colors light/dark | `ui/theme/Color.kt`, `Theme.kt` (`lightColorScheme`/custom) | `res/values/colors.xml`, `values-night/` | Asset catalog colors, `Color(...)` | `ThemeData`, `ColorScheme` | `StyleSheet`, theme files |
| Typography | `Type.kt`, `res/font/*.ttf` | `res/font`, `styles.xml` | `.font(.custom(...))`, Info.plist fonts | `TextTheme`, `pubspec.yaml` fonts | font assets |
| Shapes, sizes | `RoundedCornerShape(...)`, `dp` values | `dimens.xml`, shape drawables | `.cornerRadius`, frames | `BorderRadius` | styles |
| Animations | `spring(dampingRatio, stiffness)`, `tween(ms, easing)`, `AnimatedVisibility`, `animate*AsState`, `updateTransition`, `rememberInfiniteTransition` | `ObjectAnimator`, `res/anim`, `MotionLayout` | `.animation(.spring(response:dampingFraction:))`, `withAnimation` | `AnimationController`, `Curves.*` | `Animated`, Reanimated |
| Custom drawing | `Canvas { drawPath... }`, `Modifier.drawBehind` | custom `View.onDraw` | `Shape`/`Path`, `CALayer` | `CustomPainter` | `react-native-svg`, Skia |
| Data model | Room `@Entity`, `@Dao`, migrations, `schemas/*.json` | same | Core Data `.xcdatamodeld`, SwiftData `@Model`, GRDB | `drift`/`sqflite`/`hive` | WatermelonDB, SQLite |
| Settings | DataStore / SharedPreferences | same | `UserDefaults`, `@AppStorage` | `shared_preferences` | AsyncStorage/MMKV |
| Background work | WorkManager workers | same, AlarmManager | `BGTaskScheduler` | `workmanager` plugin | headless tasks |
| Notifications | `NotificationCompat`, channels | same | `UNUserNotificationCenter` | `flutter_local_notifications` | notifee |
| Strings | `res/values/strings.xml`, hardcoded in Compose | `strings.xml` | `Localizable.strings`/`.xcstrings` | `.arb` | i18n files |
| Launcher icon | `mipmap-*/ic_launcher.xml` (adaptive: foreground, background, monochrome) | same | `AppIcon.appiconset` | per platform | per platform |
| Backup/export | look for `Backup`, `export`, `JSON` | same | `Codable` export | `toJson` | |

## The inventory (PORTING.md)

Sections, each a table `native file:line → web file → status (todo/done/verified)`:

1. **Screens and routes**: name, how it is reached (tab, push, sheet, dialog), its back behavior,
   what it shows, every action. Include empty states, loading, errors, onboarding, lock screen.
2. **Navigation chrome**: bottom bar (items, selected style, animation), top bars, FAB/central add
   button, transitions between screens (direction, duration/spring), predictive back if any.
3. **Theme**: every color token light and dark with its hex; accent/dynamic colors and how text
   colors on them are derived; gradients.
4. **Typography**: font files, every text style (size sp, weight, letter spacing, line height,
   variable font axes like `opsz`, `wdth`).
5. **Components**: buttons (pressed scale, ripple or not), cards, pills/chips, segmented controls,
   switches, text fields, pickers (date/time/color/icon), progress, charts, lists with swipe actions,
   snackbars with undo, toasts, bottom sheets (drag to dismiss), dialogs.
6. **Motion**: for each animation, the exact spec (spring dampingRatio+stiffness, or duration+easing,
   delays, staggering), what animates (scale, alpha, offset, size, color), infinite animations
   (breathing buttons, blobs), number roll animations, success bursts/confetti.
7. **Custom drawing**: paths, seeds and random generators (note the RNG: Kotlin `Random(seed)`,
   `java.util.Random`, Swift `SystemRandomNumberGenerator` is not seedable, so look for custom ones).
8. **Data**: entities/tables/columns/types, indices, migrations, default seed data, relations and
   deletion rules (what happens to children).
9. **Business logic**: calculations, recurrence, reports, search/filter rules, validation messages.
10. **Background work and notifications**: schedule, what each job does, notification texts,
    channels, tap targets (deep links).
11. **Device features**: camera/gallery (compression size/quality), files, share sheet, biometric
    lock (when it locks: e.g. after 30 s in background), haptics, voice, location, clipboard.
12. **Settings**: each preference, default, scope (per device vs per user).
13. **Integrations and secrets**: API keys, AI providers, where tokens are stored.
14. **Backup format**: exact JSON keys, version field, what is excluded (images...).
15. **Strings**: all user-visible copy, so the PWA uses the same words.
16. **Not portable**: home screen widgets, exact-alarm scheduling, background location, NFC... State
    the closest web alternative or "not available" for the README table.

## Screenshots and live comparison

- If an Android device/emulator is reachable (`adb devices`), capture each screen
  (`adb exec-out screencap -p > screen.png`) at the same size as the browser viewport (375×812 CSS
  px ≈ 1080×2400 at 2.75–2.88 density) to compare side by side.
- Otherwise ask the user for screenshots or a screen recording of key flows (animations are the
  part screenshots cannot show: read their specs from code).
- Note the device density used for any raw pixel value in code (e.g. offsets in px inside
  `graphicsLayer`/`Canvas`): web values = px / density.
