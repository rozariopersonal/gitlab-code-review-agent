import { Gitlab } from '@gitbeaker/rest';

export { Gitlab };

export class GitLabClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.api = token ? new Gitlab({ host: this.baseUrl, token }) : null;
  }

  get connected() {
    return !!this.api;
  }

  connect(token) {
    this.api = new Gitlab({ host: this.baseUrl, token });
  }

  async findUser(username) {
    const list = await this.api.Users.all({ username });
    return list[0] || null;
  }

  async createUser({ username, name, email, password }) {
    return this.api.Users.create({ username, name, email, password, skip_confirmation: true });
  }

  async ensurePat(userId) {
    const existing = await this.api.PersonalAccessTokens.all({ userId });
    if (existing?.length) {
      await Promise.all(existing.map(t =>
        this.api.PersonalAccessTokens.remove({ tokenId: t.id }).catch(() => {})
      ));
    }
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    const token = await this.api.PersonalAccessTokens.create(
      userId,
      'ci-review',
      ['api'],
      { expiresAt: expiresAt.toISOString().split('T')[0] },
    );
    return token.token;
  }

  async findGroup(name) {
    const list = await this.api.Groups.all({ search: name });
    return list[0] || null;
  }

  async createGroup(name) {
    return this.api.Groups.create(name, name);
  }

  async addMember(groupId, userId, accessLevel) {
    try {
      return await this.api.GroupMembers.add(groupId, accessLevel, { userId });
    } catch (e) {
      if (e.message?.includes('already exists') || e.description?.includes('already exists')) return;
      throw e;
    }
  }

  async listRunners() {
    return this.api.Runners.all();
  }

  async findProject(name, namespaceId) {
    const list = await this.api.Projects.all({ search: name });
    return list.find(p => p.name === name && p.namespace?.id === namespaceId) || null;
  }

  async createProject(name, namespaceId) {
    return this.api.Projects.create({ name, namespace_id: namespaceId, visibility: 'public' });
  }

  async setVariable(projectId, key, value, masked = true) {
    try {
      await this.api.ProjectVariables.edit(projectId, key, value, { masked });
    } catch {
      await this.api.ProjectVariables.create(projectId, key, value, { masked });
    }
  }

  async unprotectBranch(projectId, branch = 'main') {
    try {
      await this.api.ProtectedBranches.remove(projectId, branch);
      return true;
    } catch {
      return false;
    }
  }

  async createLabel(projectId, name, color) {
    try {
      return await this.api.ProjectLabels.create(projectId, name, color);
    } catch {}
  }

  async getRunnerRegistrationToken() {
    try {
      const settings = await this.api.ApplicationSettings.show();
      return settings.runner_registration_token || null;
    } catch {
      return null;
    }
  }
}
