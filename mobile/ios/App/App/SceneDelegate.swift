import UIKit
import Capacitor
import PleiadRemote

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let root = PleiadBridgeViewController()
        let links = options.urlContexts.map { $0.url }
        root.resumeOnLaunch = links.isEmpty && session.stateRestorationActivity == nil
        window = UIWindow(windowScene: scene)
        window?.rootViewController = root
        window?.makeKeyAndVisible()
        for url in links { root.offerLink(url) }
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: options)
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        for context in contexts { (window?.rootViewController as? PleiadBridgeViewController)?.offerLink(context.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: contexts)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? PleiadBridgeViewController)?.hostWindow?.enterForeground()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        (window?.rootViewController as? PleiadBridgeViewController)?.hostWindow?.enterBackground()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        (window?.rootViewController as? PleiadBridgeViewController)?.hostWindow?.leave(forget: false)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
