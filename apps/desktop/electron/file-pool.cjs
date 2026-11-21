// Keep a file channel tied to the bridge generation and profile that opened it.
class FilePool {
  entries = new Map();
  constructor(bridges) {
    this.bridges = bridges;
  }
  get(id, create) {
    const bridge = this.bridges.get(id);
    let cached = this.entries.get(id);
    if (!cached || cached.bridge !== bridge) {
      cached?.files.close();
      cached = {
        bridge,
        files: create({
          open: () => {
            if (!bridge || this.bridges.get(id) !== bridge) throw new Error('还没有连上此服务。');
            return bridge.openFiles();
          },
        }),
      };
      this.entries.set(id, cached);
    }
    return cached.files;
  }
  close(id) {
    this.entries.get(id)?.files.close();
    this.entries.delete(id);
  }
  closeAll() {
    for (const id of this.entries.keys()) this.close(id);
  }
}
module.exports = { FilePool };
