use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum LoginStatus {
    LoggedOut,
    LoggedIn {
        #[serde(skip_serializing_if = "Option::is_none")]
        user_id: Option<uuid::Uuid>,
    },
}
