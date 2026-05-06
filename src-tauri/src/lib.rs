pub mod engine;

use engine::frame::native_render_graph;
use engine::gpu::GpuRenderState;
use engine::video_export::{
    ffmpeg_cancel_encode, ffmpeg_check_available, ffmpeg_finish_encode, ffmpeg_start_encode,
    ffmpeg_write_frame, VideoExportState,
};
use tauri::menu::{AboutMetadataBuilder, Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(VideoExportState::new())
        .manage(GpuRenderState::new())
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(on_menu_event)
        .invoke_handler(tauri::generate_handler![
            native_render_graph,
            ffmpeg_check_available,
            ffmpeg_start_encode,
            ffmpeg_write_frame,
            ffmpeg_finish_encode,
            ffmpeg_cancel_encode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Dither Lab".to_string()))
        .version(Some(env!("CARGO_PKG_VERSION").to_string()))
        .build();

    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new-project", "New Project")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open-project", "Open Project...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save-project", "Save Project")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save-project-as", "Save Project As...")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("open-source", "Open Source...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("export", "Export...")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        );

    #[cfg(not(target_os = "macos"))]
    let file_submenu = file_submenu.separator().quit();

    let file_submenu = file_submenu.build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(
            &MenuItemBuilder::with_id("undo", "Undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("redo", "Redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(app)?,
        )
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("toggle-scopes", "Toggle Scopes").build(app)?)
        .item(
            &MenuItemBuilder::with_id("toggle-pixel-inspector", "Toggle Pixel Inspector")
                .build(app)?,
        )
        .separator()
        .fullscreen()
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let app_submenu = SubmenuBuilder::new(app, "Dither Lab")
            .about(Some(about_metadata))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        Menu::with_items(
            app,
            &[
                &app_submenu,
                &file_submenu,
                &edit_submenu,
                &view_submenu,
                &window_submenu,
            ],
        )
    }

    #[cfg(not(target_os = "macos"))]
    {
        let about_submenu = SubmenuBuilder::new(app, "About")
            .about(Some(about_metadata))
            .build()?;

        Menu::with_items(
            app,
            &[
                &file_submenu,
                &edit_submenu,
                &view_submenu,
                &window_submenu,
                &about_submenu,
            ],
        )
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().0.clone();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("menu:action", id);
    }
}
