#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface NMAppearancePack : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) NSString *nameZH;
@property(nonatomic, copy) NSString *nameEN;
@property(nonatomic, copy) NSString *author;
@property(nonatomic, copy) NSString *reviewID;
@property(nonatomic, strong) NSURL *directoryURL;
@property(nonatomic, strong) NSImage *previewImage;
@property(nonatomic, copy) NSArray<NSDictionary *> *layers;
@property(nonatomic, copy) NSDictionary<NSString *, NSImage *> *images;
@property(nonatomic) CGFloat plusY;
- (NSString *)localizedName;
- (void)drawAtPhase:(CGFloat)phase;
@end

@interface NMAppearancePackStore : NSObject
+ (NSURL *)packsDirectoryURL;
+ (NSArray<NMAppearancePack *> *)loadInstalledPacks:(NSError **)error;
+ (nullable NMAppearancePack *)installArchiveAtURL:(NSURL *)archiveURL error:(NSError **)error;
+ (BOOL)removePack:(NMAppearancePack *)pack error:(NSError **)error;
+ (nullable NMAppearancePack *)validatePackDirectory:(NSURL *)directoryURL error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
