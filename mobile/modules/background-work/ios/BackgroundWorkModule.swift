import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

/**
 Keeps the app running while JS answers a notification's action button.

 expo-notifications tells iOS that an action is handled as soon as it has
 passed it on to JS, and iOS may then suspend the app before JS has reached
 the computer. Background time is asked for here, in the same main-thread
 call that hands the action over, so there is no gap; JS gives it back with
 `finish()` once the answer is sent, and iOS ends it when the time runs out.
 */
public class BackgroundWorkModule: Module, NotificationDelegate {
  private let lock = NSLock()
  private var tasks: [UIBackgroundTaskIdentifier] = []

  public func definition() -> ModuleDefinition {
    Name("BackgroundWork")

    OnCreate {
      NotificationCenterManager.shared.addDelegate(self)
    }

    OnDestroy {
      NotificationCenterManager.shared.removeDelegate(self)
      self.finishAll()
    }

    Function("finish") {
      self.finishAll()
    }
  }

  public func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let action = response.actionIdentifier
    if action == UNNotificationDefaultActionIdentifier || action == UNNotificationDismissActionIdentifier {
      return false
    }
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "Notification action") { [weak self] in
      self?.end(task)
    }
    if task != .invalid {
      lock.lock()
      tasks.append(task)
      lock.unlock()
    }
    // Not handled here: expo-notifications still delivers it to JS.
    return false
  }

  private func end(_ task: UIBackgroundTaskIdentifier) {
    lock.lock()
    let held = tasks.contains(task)
    tasks.removeAll { $0 == task }
    lock.unlock()
    if held {
      UIApplication.shared.endBackgroundTask(task)
    }
  }

  private func finishAll() {
    lock.lock()
    let all = tasks
    tasks.removeAll()
    lock.unlock()
    for task in all {
      UIApplication.shared.endBackgroundTask(task)
    }
  }
}
