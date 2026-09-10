//! Tauri commands for the ChatGPT subscription connection.
//!
//! Nothing here ever returns a token. `chatgpt_status` is the only read, and it
//! carries the account label and the expiry so the card can render itself.

use tauri::{AppHandle, Runtime, State};

use crate::core::auth::chatgpt;
use crate::core::auth::state::{data_dir_for, now_unix, ChatGptStatus};
use crate::core::state::AppState;

#[tauri::command]
pub async fn chatgpt_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<ChatGptStatus, String> {
    let data_dir = data_dir_for(&app);
    Ok(state.chatgpt_auth.status(&data_dir).await)
}

/// Open the system browser, wait for the loopback callback, exchange the code.
///
/// Deliberately one long-running command rather than start/poll: the caller
/// awaits a single promise and gets either a connected status or the reason it
/// failed, and there is no half-state to reconcile if the app closes midway.
#[tauri::command]
pub async fn chatgpt_login<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<ChatGptStatus, String> {
    let data_dir = data_dir_for(&app);
    let auth = state.chatgpt_auth.clone();

    let pkce = chatgpt::new_pkce();
    let oauth_state = chatgpt::new_state();
    let url = chatgpt::authorize_url(&pkce, &oauth_state);

    let cancel = auth.arm_cancel();

    // Bind the listener before the browser opens, so a busy port fails here
    // instead of after the user has already signed in.
    let callback = chatgpt::await_callback(oauth_state, chatgpt::CALLBACK_TIMEOUT, cancel);

    if let Err(err) = tauri_plugin_opener::open_url(&url, None::<&str>) {
        auth.disarm_cancel();
        return Err(format!("cannot open the browser for sign-in: {err}"));
    }

    let code = match callback.await {
        Ok(code) => code,
        Err(err) => {
            auth.disarm_cancel();
            return Err(err);
        }
    };
    auth.disarm_cancel();

    let tokens = chatgpt::exchange_code(&code, &pkce, now_unix()).await?;
    auth.set(&data_dir, tokens).await?;
    Ok(auth.status(&data_dir).await)
}

/// Abandon a sign-in that is still waiting on the browser.
#[tauri::command]
pub async fn chatgpt_cancel_login(state: State<'_, AppState>) -> Result<(), String> {
    state.chatgpt_auth.cancel_login();
    Ok(())
}

/// What the connected subscription can serve, straight from the account.
///
/// A separate command rather than part of the status: the status is polled on
/// every mount, and this is a network round trip.
#[tauri::command]
pub async fn chatgpt_models<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::core::server::chatgpt_route::SubscriptionModel>, String> {
    let data_dir = data_dir_for(&app);
    let client = crate::core::server::chatgpt_route::client()?;
    crate::core::server::chatgpt_route::list_models(&client, &state.chatgpt_auth, &data_dir).await
}

#[tauri::command]
pub async fn chatgpt_logout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<ChatGptStatus, String> {
    let data_dir = data_dir_for(&app);
    state.chatgpt_auth.logout(&data_dir).await?;
    Ok(state.chatgpt_auth.status(&data_dir).await)
}
