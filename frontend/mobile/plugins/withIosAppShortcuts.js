/**
 * Expo config plugin for Veil's read-only iOS App Intents extension.
 *
 * The extension never performs network requests and never links wallet signing
 * code. It reads a small, non-secret snapshot written by the React Native app
 * through its existing balance/price paths.
 */
const fs = require('fs');
const path = require('path');
const {
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const TARGET_NAME = 'VeilAppIntents';
const SOURCE_FILE = 'VeilAppIntents.swift';
const INFO_PLIST = 'Info.plist';
const ENTITLEMENTS = 'VeilAppIntents.entitlements';
const APP_GROUP = 'group.xyz.veil.wallet.voice';
const SNAPSHOT_KEY = 'veil_voice_snapshot';
const KEYCHAIN_SERVICE = 'xyz.veil.wallet.voice.snapshot';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Veil App Intents</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>EXAppExtensionAttributes</key>
  <dict>
    <key>EXExtensionPointIdentifier</key>
    <string>com.apple.appintents-extension</string>
  </dict>
</dict>
</plist>
`;
}

function renderEntitlements() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${xmlEscape(APP_GROUP)}</string>
  </array>
</dict>
</plist>
`;
}

function renderSwift() {
  return `import AppIntents
import Foundation
import Security

private let snapshotAccessGroup = "${APP_GROUP}"
private let snapshotService = "${KEYCHAIN_SERVICE}"
private let snapshotAccount = "${SNAPSHOT_KEY}"

private struct VoiceAssetQuote: Decodable {
    let code: String
    let issuer: String?
    let priceUsd: Double?
}

private struct VoiceSnapshot: Decodable {
    let version: Int
    let updatedAt: String
    let network: String
    let xlmBalance: String
    let prices: [VoiceAssetQuote]
}

private enum SnapshotStore {
    static func read() -> VoiceSnapshot? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: snapshotService,
            kSecAttrAccount: snapshotAccount,
            kSecAttrAccessGroup: snapshotAccessGroup,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else {
            return nil
        }

        return try? JSONDecoder().decode(VoiceSnapshot.self, from: data)
    }
}

private enum VoiceAssetResolver {
    static func quote(
        code rawCode: String,
        issuer rawIssuer: String?,
        in snapshot: VoiceSnapshot
    ) -> Result<VoiceAssetQuote, String> {
        let code = rawCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let issuer = rawIssuer?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmptyIssuer = (issuer?.isEmpty == false) ? issuer : nil

        if code == "XLM" {
            guard nonEmptyIssuer == nil else {
                return .failure("That issuer does not identify Stellar's native XLM.")
            }
            guard let quote = snapshot.prices.first(where: {
                $0.code == "XLM" && $0.issuer == nil
            }) else {
                return .failure("XLM price is not available in the latest Veil snapshot.")
            }
            return .success(quote)
        }

        let candidates = snapshot.prices.filter { $0.code == code && $0.issuer != nil }
        guard !candidates.isEmpty else {
            return .failure("\\(code) is not a verified asset in the latest Veil snapshot.")
        }

        if let expectedIssuer = nonEmptyIssuer {
            guard let exact = candidates.first(where: { $0.issuer == expectedIssuer }) else {
                return .failure("The supplied issuer for \\(code) is unverified.")
            }
            return .success(exact)
        }

        // The app writes only issuer-pinned registry assets. A code is therefore
        // safe to resolve without speaking a 56-character issuer only when the
        // snapshot contains exactly one verified issuer for it.
        guard candidates.count == 1, let quote = candidates.first else {
            return .failure("\\(code) needs an exact verified issuer.")
        }
        return .success(quote)
    }
}

@available(iOS 16.0, *)
struct ShowBalanceIntent: AppIntent {
    static var title: LocalizedStringResource = "Current wallet balance"
    static var description = IntentDescription("Reads Veil's last refreshed wallet balance. This intent cannot sign or move funds.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = SnapshotStore.read() else {
            return .result(dialog: "Open Veil once to refresh your read-only balance snapshot.")
        }

        let balance = snapshot.xlmBalance.isEmpty ? "0" : snapshot.xlmBalance
        return .result(dialog: IntentDialog(stringLiteral: "Your Veil balance is \\(balance) XLM."))
    }
}

@available(iOS 16.0, *)
struct ShowAssetPriceIntent: AppIntent {
    static var title: LocalizedStringResource = "Asset price"
    static var description = IntentDescription("Reads the last Veil price for an issuer-pinned asset. This intent cannot sign or move funds.")
    static var openAppWhenRun = false

    @Parameter(title: "Asset")
    var assetCode: String

    @Parameter(title: "Issuer", description: "Optional Stellar issuer. If supplied, it must match Veil's verified issuer exactly.")
    var issuer: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Get the Veil price of \\(.\$assetCode)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = SnapshotStore.read() else {
            return .result(dialog: "Open Veil once to refresh your read-only price snapshot.")
        }

        switch VoiceAssetResolver.quote(code: assetCode, issuer: issuer, in: snapshot) {
        case .failure(let reason):
            return .result(dialog: IntentDialog(stringLiteral: reason))
        case .success(let quote):
            guard let price = quote.priceUsd else {
                return .result(dialog: IntentDialog(stringLiteral: "No current price is available for \\(quote.code)."))
            }
            let formatted = String(format: "%.4f", price)
            return .result(dialog: IntentDialog(stringLiteral: "\\(quote.code) is about $\\(formatted) USD in Veil's latest snapshot."))
        }
    }
}

@available(iOS 16.0, *)
struct VeilReadOnlyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ShowBalanceIntent(),
            phrases: [
                "What is my balance in \\(.applicationName)",
                "Show my balance in \\(.applicationName)",
            ],
            shortTitle: "Wallet balance",
            systemImageName: "chart.bar"
        )
        AppShortcut(
            intent: ShowAssetPriceIntent(),
            phrases: [
                "What is an asset worth in \\(.applicationName)",
                "Check an asset price in \\(.applicationName)",
            ],
            shortTitle: "Asset price",
            systemImageName: "chart.line.uptrend.xyaxis"
        )
    }
}
`;
}

function addUniqueAppGroup(entitlements) {
  const key = 'com.apple.security.application-groups';
  const current = Array.isArray(entitlements[key]) ? entitlements[key] : [];
  entitlements[key] = Array.from(new Set([...current, APP_GROUP]));
}

function declareEasExtension(config, bundleIdentifier) {
  config.extra = config.extra || {};
  config.extra.eas = config.extra.eas || {};
  config.extra.eas.build = config.extra.eas.build || {};
  config.extra.eas.build.experimental = config.extra.eas.build.experimental || {};
  config.extra.eas.build.experimental.ios =
    config.extra.eas.build.experimental.ios || {};

  const ios = config.extra.eas.build.experimental.ios;
  const current = Array.isArray(ios.appExtensions) ? ios.appExtensions : [];
  const declaration = {
    targetName: TARGET_NAME,
    bundleIdentifier,
    entitlements: {
      'com.apple.security.application-groups': [APP_GROUP],
    },
  };
  ios.appExtensions = [
    ...current.filter((entry) => entry && entry.targetName !== TARGET_NAME),
    declaration,
  ];
}

function addSourceOnce(project, relativePath, targetUuid) {
  const existing = Object.values(project.pbxFileReferenceSection()).some(
    (file) =>
      file &&
      typeof file === 'object' &&
      (file.path === relativePath || file.path === `"${relativePath}"`),
  );
  if (!existing) project.addSourceFile(relativePath, { target: targetUuid });
}

function addFrameworkOnce(project, framework, targetUuid) {
  const existing = Object.values(project.pbxFileReferenceSection()).some(
    (file) =>
      file &&
      typeof file === 'object' &&
      (file.path === framework || file.path === `"${framework}"`),
  );
  if (!existing) project.addFramework(framework, { target: targetUuid });
}

function withIosAppShortcuts(config) {
  const appBundleIdentifier = config.ios?.bundleIdentifier;
  if (!appBundleIdentifier) {
    throw new Error('withIosAppShortcuts: ios.bundleIdentifier must be set.');
  }
  const extensionBundleIdentifier = `${appBundleIdentifier}.appintents`;
  declareEasExtension(config, extensionBundleIdentifier);

  config = withEntitlementsPlist(config, (current) => {
    addUniqueAppGroup(current.modResults);
    return current;
  });

  config = withDangerousMod(config, [
    'ios',
    (current) => {
      const dir = path.join(current.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, SOURCE_FILE), renderSwift());
      fs.writeFileSync(path.join(dir, INFO_PLIST), renderInfoPlist());
      fs.writeFileSync(path.join(dir, ENTITLEMENTS), renderEntitlements());
      return current;
    },
  ]);

  config = withXcodeProject(config, (current) => {
    const project = current.modResults;
    const existingUuid = project.findTargetKey(TARGET_NAME);
    const target = existingUuid
      ? { uuid: existingUuid }
      : project.addTarget(
          TARGET_NAME,
          'app_extension',
          TARGET_NAME,
          extensionBundleIdentifier,
        );

    if (!existingUuid) {
      project.addTargetDependency(project.getFirstTarget().uuid, [target.uuid]);
    }

    addSourceOnce(project, `${TARGET_NAME}/${SOURCE_FILE}`, target.uuid);
    addFrameworkOnce(project, 'AppIntents.framework', target.uuid);
    addFrameworkOnce(project, 'Security.framework', target.uuid);

    project.addBuildProperty(
      'INFOPLIST_FILE',
      `"${TARGET_NAME}/${INFO_PLIST}"`,
      undefined,
      TARGET_NAME,
    );
    project.addBuildProperty(
      'CODE_SIGN_ENTITLEMENTS',
      `"${TARGET_NAME}/${ENTITLEMENTS}"`,
      undefined,
      TARGET_NAME,
    );
    project.addBuildProperty(
      'PRODUCT_BUNDLE_IDENTIFIER',
      extensionBundleIdentifier,
      undefined,
      TARGET_NAME,
    );
    project.addBuildProperty('SWIFT_VERSION', '5.0', undefined, TARGET_NAME);
    project.addBuildProperty(
      'IPHONEOS_DEPLOYMENT_TARGET',
      '16.0',
      undefined,
      TARGET_NAME,
    );
    project.addBuildProperty(
      'APPLICATION_EXTENSION_API_ONLY',
      'YES',
      undefined,
      TARGET_NAME,
    );

    return current;
  });

  return config;
}

module.exports = withIosAppShortcuts;
module.exports.renderSwift = renderSwift;
module.exports.renderInfoPlist = renderInfoPlist;
module.exports.renderEntitlements = renderEntitlements;
module.exports.declareEasExtension = declareEasExtension;
module.exports.APP_GROUP = APP_GROUP;
module.exports.TARGET_NAME = TARGET_NAME;
