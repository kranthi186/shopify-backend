const Shopify = require('shopify-api-node');
const fs = require('fs');
const Client = require('ssh2-sftp-client');
const delay = require('delay');
const TSV = require('tsv');

const Vendor = require('../../models/Vendor');
const Connector = require('../../models/Connector');
const History = require('../../models/History');

/**
 * GET /
 * Inventory page.
 */
exports.index = async (req, res, next) => {

    var vendorInfo, connectorInfo;
    var inventoryFileName = '';
    var shopify = null;
    var errorExist = false;
    Vendor.findOne({
        _id: req.user.vendorId
    }, (vendorError, vendor) => {
        if (vendorError) {
            return next(vendorError);
        }
        vendorInfo = vendor;
        inventoryFileName = 'uploads/inventory-' + vendor.api.apiShop + '.txt';

        if (vendorInfo.api.apiShop == '' || vendorInfo.api.apiKey == '' || vendorInfo.api.apiPassword == '') {
            req.flash('errors', {
                msg: 'You should have API information to manage product feed. Please contact with Administrator.'
            });
            errorExist = true;
            res.redirect('/');
            return next();
        }
        if (vendorInfo.sftp.sftpHost == '' || vendorInfo.sftp.sftpPassword == '' || vendorInfo.sftp.sftpUsername == '') {
            req.flash('errors', {
                msg: 'You should have SFTP information to manage product feed. Please contact with Administrator.'
            });
            errorExist = true;
            res.redirect('/');
            return next();
        }
        if (vendorInfo.active == 'yes') {
            shopify = new Shopify({
                shopName: vendorInfo.api.apiShop,
                apiKey: vendorInfo.api.apiKey,
                password: vendorInfo.api.apiPassword,
                timeout: 50000,
                autoLimit: {
                    calls: 2,
                    interval: 1000,
                    bucketSize: 35
                }
            });
        }
        // Check vendor availability. If vendor's status is inactive, it should redirect to homepage without any action.
        if (vendorInfo.active == 'no') {
            req.flash('errors', {
                msg: 'Your vendor should be active to manage feed. Please contact with Administrator.'
            });
            errorExist = true;
            res.redirect('/');
            return next();
        }

        // Check inventory connector
        Connector.find({
            vendorId: vendorInfo._id,
            kwiLocation: 'inventory',
            active: 'yes'
        }, (err, connectors) => {
            if (err) {
                return next(err);
            }
            if (connectors.length == 0) {
                req.flash('errors', {
                    msg: 'Your vendor does not include inventory connector or it is inactive. Please contact with Administrator or Admin User.'
                });
                errorExist = true;
                res.redirect('/');
                return next();
            }
            connectorInfo = connectors[0];
        });
    });

    const sftp = new Client();
    var inventoryDataList = [];

    // Initialize product feed file with empty
    deleteAndInitialize(inventoryFileName);

    // Check user's active/inactive status.
    if (req.user.active !== 'yes') {
        req.flash('errors', {
            msg: 'Your account is inactive now. Please contact with Administrator.'
        });
        errorExist = true;
        res.redirect('/');
        return next();
    }

    await delay(2000);
    if (!errorExist) {
        shopify.product.list()
            .then(products => {
                products.forEach(product => {
                    product.variants.forEach(variant => {
                        var inventoryData = {};
                        inventoryData.id = variant.id;
                        inventoryData.qty_on_hand = variant.inventory_quantity < 0 ? 0 : variant.inventory_quantity;
                        inventoryData.date_available = product.published_at;

                        inventoryDataList.push(inventoryData);
                    });
                });
            })
            .then(async () => {
                await delay(2000);
                sftp.connect({
                        host: vendorInfo.sftp.sftpHost,
                        port: process.env.SFTP_PORT,
                        username: vendorInfo.sftp.sftpUsername,
                        password: vendorInfo.sftp.sftpPassword
                    })
                    .then(async () => {
                        await delay(1000);
                        fs.writeFile(inventoryFileName, TSV.stringify(inventoryDataList), (err) => {
                            if (err) {
                                console.log('Writing File Error: ', err);
                            } else {
                                var currentDate = new Date();
                                var temp = currentDate.toLocaleString("en-US", {
                                    hour12: false
                                }).split('.');
                                var remotePath = '/incoming/inventory/inventory' + temp[0].replace(' ', '').replace(/\-/g, '').replace(/\:/g, '').replace(/\//g, '').replace(',', '') + '.txt';
                                sftp.put(inventoryFileName, remotePath)
                                .then(response => {
                                    addHistory(vendorInfo, connectorInfo, 2, (historyErr) => {
                                        if (historyErr) {
                                            return next(historyErr);
                                        } else {
                                            res.render('feeds/inventory', {
                                                title: 'Inventory',
                                                inventoryList: inventoryDataList
                                            });
                                        }
                                    });
                                    
                                    sftp.end();
                                })
                                .catch(error => {
                                    addHistory(vendorInfo, connectorInfo, 0, (historyErr) => {
                                        if (historyErr) {
                                            return next(historyErr);
                                        } else {
                                            console.log('upload error: ', error);
                                        }
                                    });
                                });
                            }
                        });
                    })
                    .catch(error => {
                        addHistory(vendorInfo, connectorInfo, 0, (historyErr) => {
                            if (historyErr) {
                                return next(historyErr);
                            } else {
                                console.log('connect error: ', error)
                            }
                        });
                    });
            })
            .catch(err => {
                addHistory(vendorInfo, connectorInfo, 0, (historyErr) => {
                    if (historyErr) {
                        return next(historyErr);
                    } else {
                        console.log('collectError: ', err)
                    }
                });
            });
    }

};

const deleteAndInitialize = function (filePath) {
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) throw err;
            console.log(filePath + ' file has been deleted');
            fs.writeFile(filePath, '', function (initErr) {
                if (initErr) {
                    console.log(initErr);
                }
                console.log('Made inventory file and initialized with empty');
            });
        });
    }
}

const addHistory = (vendor, connector, statusFlag, callback) => {
    History.find({
        vendorId: vendor._id,
        connectorId: connector._id,
        status: statusFlag
    }, (err, histories) => {
        if (err) {
            callback(err);
        }
        if (histories.length == 0) {
            var history = new History();
            history.vendorId = vendor._id;
            history.vendorName = vendor.api.apiShop;
            history.connectorId = connector._id;
            history.connectorType = connector.kwiLocation;
            history.counter = 1;
            history.status = statusFlag;

            history.save().then(() => {
                callback(null);
            });
        } else {
            var history = histories[0];
            history.update({ $inc: { counter: 1 }},() => {
                callback(null);
            });
        }
    });
};