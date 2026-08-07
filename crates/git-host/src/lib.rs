mod detection;
mod types;

pub mod github;

use std::path::Path;

use async_trait::async_trait;
use detection::detect_provider_from_url;
pub use types::{
    CreatePrRequest, GitHostError, PrComment, PrCommentAuthor, PrReviewComment, ProviderKind,
    PullRequestDetail, ReviewCommentUser, UnifiedPrComment,
};

use self::github::GitHubProvider;

#[async_trait]
pub trait GitHostProvider: Send + Sync {
    async fn create_pr(
        &self,
        repo_path: &Path,
        remote_url: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GitHostError>;

    async fn get_pr_status(&self, pr_url: &str) -> Result<PullRequestDetail, GitHostError>;

    async fn list_prs_for_branch(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError>;

    async fn get_pr_comments(
        &self,
        repo_path: &Path,
        remote_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError>;

    async fn list_open_prs(
        &self,
        repo_path: &Path,
        remote_url: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError>;

    fn provider_kind(&self) -> ProviderKind;
}

/// Newtype over `GitHubProvider` — the only PR host supported by this fork.
/// Retained as a struct (rather than exposing `GitHubProvider` directly) so the
/// `GitHostProvider` trait dispatch site stays uniform for future-proofing.
pub struct GitHostService(GitHubProvider);

impl GitHostService {
    pub fn from_url(url: &str) -> Result<Self, GitHostError> {
        match detect_provider_from_url(url) {
            ProviderKind::GitHub => Ok(Self(GitHubProvider::new()?)),
            ProviderKind::Unknown => Err(GitHostError::UnsupportedProvider),
        }
    }
}

#[async_trait]
impl GitHostProvider for GitHostService {
    async fn create_pr(
        &self,
        repo_path: &Path,
        remote_url: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GitHostError> {
        self.0.create_pr(repo_path, remote_url, request).await
    }

    async fn get_pr_status(&self, pr_url: &str) -> Result<PullRequestDetail, GitHostError> {
        self.0.get_pr_status(pr_url).await
    }

    async fn list_prs_for_branch(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError> {
        self.0
            .list_prs_for_branch(repo_path, remote_url, branch_name)
            .await
    }

    async fn get_pr_comments(
        &self,
        repo_path: &Path,
        remote_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError> {
        self.0
            .get_pr_comments(repo_path, remote_url, pr_number)
            .await
    }

    async fn list_open_prs(
        &self,
        repo_path: &Path,
        remote_url: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError> {
        self.0.list_open_prs(repo_path, remote_url).await
    }

    fn provider_kind(&self) -> ProviderKind {
        self.0.provider_kind()
    }
}
