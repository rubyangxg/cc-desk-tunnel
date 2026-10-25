// Each saved service owns a bridge. Reconnecting one must not close another service's SSH channels.
class BridgePool {
  entries = new Map();
  generations = new Map();
  last = new Map();
  constructor(changed = () => {}) {
    this.changed = changed;
  }
  async connect(id, open, closed = () => {}) {
    const closing = this.disconnect(id);
    const generation = this.generations.get(id);
    await closing;
    if (generation !== this.generations.get(id)) throw new Error('Connection cancelled');
    let connection;
    connection = await open(() => {
      if (!connection || this.entries.get(id) !== connection) return;
      this.entries.delete(id);
      this.changed(this.entries.size);
      closed();
    });
    if (generation !== this.generations.get(id)) {
      await connection.close();
      throw new Error('Connection cancelled');
    }
    this.entries.set(id, connection);
    this.last.set(id, connection);
    this.changed(this.entries.size);
    return connection;
  }
  async disconnect(id) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const previous = this.entries.get(id);
    this.entries.delete(id);
    this.changed(this.entries.size);
    await previous?.close();
  }
  async close() {
    await Promise.all([...this.generations.keys()].map((id) => this.disconnect(id)));
  }
}
module.exports = { BridgePool };
