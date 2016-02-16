var Promise = require('bluebird'),
    fs      = Promise.promisifyAll(require('fs')),
    _       = require('lodash'),
    path    = require('path'),
    config  = require('../config'),
    errors  = require('../errors'),
    rimraf  = require('rimraf'),
    rirmafPromise = require('rimraf-promise'),

    localCloud;

// 格式化文件大小格式
function formatFileSize(size) {
    var unit = ['Byte', 'KB', 'GB', 'TB'],
        i = 0,
        filesize;
    while(size >= 1024) {
        size = size / 1024;
        i++;
    }
    filesize = size + unit[i];
    return size.toFixed(2) + unit[i];
}

function validateName(object, name) {
    if(_.isEmpty(object[name]))
        return Promise.reject(name + ' can not be empty');
    if(!_.isString(object[name]))
        return Promise.reject(name + ' must be a string');
    if(!/^[^\\/?%*:|"<>\.]+$/.test(object[name]))
        return Promise.reject(object[name] + ' is not a valid name');
    return Promise.resolve();
}

function deleteFolderRecursive(delpath) {
    if(fs.existsSync(delpath)) {
        fs.readdirSync(delpath).forEach(function(file, index){
            var curPath = path.join(delpath, file);
            if(fs.statSync(curPath).isDirectory()) {
                deleteFolderRecursive(curPath);
            } else {
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(path);
    }
    return true;
}

LocalCloud = function LocalCloud(settings) {
    var buckets = settings.buckets,
        bucket,
        path,
        i,
        len;
    if(!_.isArray(buckets))
        buckets = [];
    this.settings = settings;
    this.buckets = {};
    if(buckets) {
        for(i = 0, len = buckets.length; i < len; i++) {
            bucket = buckets[i];
            path = settings.rootPath + bucket.path;
            var stat = fs.statSync(path);
            if(!stat.isDirectory())
                throw new Error(path + 'is not a directory');

            // 注册bucket
            this.buckets[bucket.name] = {
                Endpoint: path,
                Name: bucket.name,
                path: path,
                relativePath: bucket.path
            };
        }
    }
};

// 遍历params来查找options的参数的合法性
LocalCloud.prototype.validateOptions = function validateOptions(options, params, keyType) {
    if(_.isString(params)) params = [params];
    if(!_.isArray(params)) params = [];
    for(var i = 0, len = params.length; i < len; i++) {
        var param = params[i];
        // 检查参数是否存在
        if(!options[param] || _.isEmpty(options[param])) {
            return Promise.reject(new errors.ValidationError(param + 'is required, can\'t be empty'));
        }

        // check if the bucket is illegal
        if(param === 'bucket') {
            var bucket_find = false;
            _.forEach(this.buckets, function(bucket, name) {
                if(name === options.bucket) {
                    options.bucket = bucket;
                    bucket_find = true;
                }
            });
            if(!bucket_find) return Promise.reject(new errors.ValidationError(options.bucket + 'is not existed'));
        }

        // check if the key is illegal
        // key can be folder or a file
        if(param === 'key') {
            // key 的范围只能在rootPath 下
            var keyPath = path.join(options.bucket.path, options.key);
            console.log('keyPath', keyPath);
            if(!(new RegExp("^" + this.settings.rootPath).test(keyPath))) {
                return Promise.reject(new errors.ValidationError('can not reach that place: '+keyPath));
            }
            options.keyPath = keyPath;
            if(!fs.existsSync(keyPath)) {
                return Promise.reject(new errors.NotFoundError(keyPath + ' is not exist'));
            }

            if(keyType === 'folder' && !fs.statSync(keyPath).isDirectory()) {
                return Promise.reject(new errors.BadRequestError(keyPath + ' is not a folder'));
            } else if(keyType === 'object') {
                //
            } else {
                options.stat = fs.statSync(keyPath);
            }
            return Promise.resolve(options);
        }
    }
    return Promise.resolve(options);
}

LocalCloud.prototype.listBuckets = function listBuckets() {
    var buckets = [];
    _.forEach(this.buckets, function(bucket, name) {
        buckets.push({
            Name: name,
            // 如果为aliyun oss 则可将多余数据放入Addition中, 每次请求的时候提交
            Addition: {
                Endpoint: bucket.Endpoint
            }
        });
    });
    return Promise.resolve(buckets);
};

LocalCloud.prototype.listFolders = function listFolders(options) {
    var params = ['bucket', 'key'],folders=[];
    console.log(options);
    return this.validateOptions(options, params, 'folder')
        .then(function then(options) {
            return fs.readdirAsync(options.keyPath)
                .then(function(files){
                    _.forEach(files, function(file) {
                        if(fs.statSync(path.join(options.keyPath, file)).isDirectory()) {
                            folders.push({
                                Key: path.join(options.key, file, '/'),
                                Name: file + '/'
                            });
                        }
                    });
                    return folders;
                });
        });
}

LocalCloud.prototype.listObjects = function listObjects(options) {
    var params = ['bucket', 'key'],
        stat,
        _this = this;
    return this.validateOptions(options, params, 'folder')
        .then(function then(options) {
            return fs.readdirAsync(options.keyPath)
                .then(function(files) {
                    var objects = {
                        files: [],
                        folders: []
                    };
                    _.forEach(files, function(file) {
                        if(!_this.settings.showHidden && /^\./.test(file))
                            return;
                        stat = fs.statSync(path.join(options.keyPath, file));
                        if(stat.isDirectory()) {
                            objects.folders.push({
                                Key: path.join(options.key, file, '/'),
                                Name: file + '/',
                                LastModified: stat.mtime
                            });
                        } else if(stat.isFile()) {
                            objects.files.push({
                                Key: path.join(options.key, file),
                                Name: file,
                                Size: stat.size,
                                LastModified: stat.mtime
                            });
                        }
                    });
                    return objects;
                });
        });
};

LocalCloud.prototype.addFolder = function addFolder(object, options) {
    var params = ['bucket', 'key'], newFolderPath, _this = this;
    return this.validateOptions(options, params, 'folder')
        .then(function then(options) {
            return validateName(object, 'newFolderName')
                .then(function(){
                    // 开始创建
                    newFolderPath = path.join(options.keyPath, object['newFolderName']);
                    return fs.mkdirAsync(newFolderPath, _this.settings.mode);
                });
        });
};

LocalCloud.prototype.deleteObjects = function deleteObjects(options) {
    var params = ['bucket', 'key'], _this = this;
    // options = options || {};
    // options.keys = object.key || '';
    return this.validateOptions(options, params)
        .then(function(options) {
            if(_.isEmpty(object.keys) || !_.isString(object.keys))
                return Promise.reject(new errors.ValidationError('Invalid key'));
            // 开始删除keys
            if(options.stat && options.stat.isDirectory()) {
                if(_this.settings.deleteMode === 'strict') {
                    // delete in strict mode
                    return rirmafPromise(options.keyPath);
                } else if(_this.settings.deleteMode === 'normal') {
                    // delete in normal mode
                    return fs.rmdirAsync(options.keyPath);
                }
            } else if(options.stat && options.stat.isFile()) {
                // we are tryint to delete a file
                return rirmafPromise(options.keyPath);
            } else {
                // other kind of fill not allow to delte
                return Promise.reject('forbidden');
            }
        });
}


module.exports = new LocalCloud(config.localCloudSettings);